// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * A compact, Session-scoped card for the experimental local research mode.
 *
 * It reads the durable operation identity from the service, not from whichever
 * tool result happens to be in the transcript: a refresh, a reopened Session or
 * an Agent between tool calls all recover the same operation without starting a
 * new one. Status and delivery are separate lines, and stop is the owned
 * service path rather than cancellation of text generation.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  ResearchArtifactRef,
  ResearchOperation,
  ResearchOperationsResponse,
  ResearchStopResponse,
} from "../api/research-operations.js";
import { useLocale } from "../i18n/index.js";
import type { MessageKey } from "../i18n/index.js";
import {
  deliveryDetail,
  deliveryLabelKey,
  deliveredResults,
  formatMetric,
  isActiveResearch,
  researchContinuationText,
  researchStages,
  researchStatus,
  researchTitle,
  shortOperationId,
  type ResearchStatusKind,
} from "./research-operation-model.js";

/** The client calls this card needs; `ApiClient` satisfies it. */
export interface ResearchOperationsPort {
  listResearchOperations(sessionId: string): Promise<ResearchOperationsResponse>;
  getResearchOperation(sessionId: string, operationId: string): Promise<ResearchOperation>;
  stopResearchOperation(sessionId: string, operationId: string): Promise<ResearchStopResponse>;
  retryResearchDelivery(sessionId: string, operationId: string): Promise<ResearchOperation>;
}

export interface ResearchOperationPanelProps {
  readonly client: ResearchOperationsPort;
  readonly isRunning: boolean;
  readonly onOpenArtifact: (ref: ResearchArtifactRef) => void;
  readonly onPrefill: (text: string) => void;
  /** Called once per operation whose delivery this card observes. */
  readonly onDelivered?: () => void;
  readonly readOnly?: boolean;
  readonly sessionId: string;
}

const STATUS_KEYS: Record<ResearchStatusKind, MessageKey> = {
  "preparing": "localResearch.status.preparing",
  "running": "localResearch.status.running",
  "stop-requested": "localResearch.status.stopRequested",
  "stopped": "localResearch.status.stopped",
  "completed": "localResearch.status.completed",
  "failed": "localResearch.status.failed",
  "unknown": "localResearch.status.unknown",
};

type Notice = { readonly operationId: string; readonly text: string; readonly tone: "done" | "failed" | "waiting" };

export function ResearchOperationPanel({
  client,
  isRunning,
  onDelivered,
  onOpenArtifact,
  onPrefill,
  readOnly = false,
  sessionId,
}: ResearchOperationPanelProps): ReactNode {
  const { t } = useLocale();
  // The Session this data belongs to is part of the state: a slow response for
  // the previous Session must never render as the current one's operations.
  const [loaded, setLoaded] = useState<{ response: ResearchOperationsResponse; sessionId: string }>();
  const [error, setError] = useState(false);
  const [notices, setNotices] = useState<Readonly<Record<string, Notice>>>({});
  const [busy, setBusy] = useState<{ action: "stop" | "retry"; operationId: string }>();
  const [showAll, setShowAll] = useState(false);
  const deliveredSeen = useRef(new Set<string>());
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  const applyOperation = useCallback((operation: ResearchOperation) => {
    setLoaded((current) => current && current.sessionId === sessionId
      ? { ...current, response: { ...current.response, operations: current.response.operations.map((item) => item.operationId === operation.operationId ? operation : item) } }
      : current);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(() => { void tick(); }, ms);
    };
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const listed = await client.listResearchOperations(sessionId);
        if (cancelled) return;
        setError(false);
        if (!listed.enabled) {
          setLoaded({ response: listed, sessionId });
          return; // Disabled mode needs no polling and shows no actions.
        }
        let operations = listed.operations;
        const active = [...operations].reverse().find(isActiveResearch);
        const newest = active ?? operations.at(-1);
        if (newest) {
          try {
            // Re-read the newest operation so its state and stages come from the
            // engine's record, not only from the last write the Agent caused.
            const fresh = await client.getResearchOperation(sessionId, newest.operationId);
            if (cancelled) return;
            operations = operations.map((item) => item.operationId === fresh.operationId ? fresh : item);
          } catch {
            // The list is still a truthful older snapshot; keep observing.
          }
        }
        if (cancelled) return;
        setLoaded({ response: { ...listed, operations }, sessionId });
        for (const operation of operations) {
          if (operation.delivery.state === "delivered" && !deliveredSeen.current.has(operation.operationId)) {
            deliveredSeen.current.add(operation.operationId);
            onDeliveredRef.current?.();
          }
        }
        const waiting = operations.some((operation) => isActiveResearch(operation)
          || (operation.delivery.state === "pending" && !isActiveResearch(operation)));
        // The read is a real engine record read, not a cheap cache hit: keep the
        // active cadence slow enough not to compete with the single CPU worker.
        schedule(waiting ? 5_000 : isRunning ? 10_000 : 60_000);
      } catch {
        if (cancelled) return;
        setError(true);
        schedule(5_000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, isRunning, sessionId]);

  const stop = async (operation: ResearchOperation): Promise<void> => {
    setBusy({ action: "stop", operationId: operation.operationId });
    try {
      const outcome = await client.stopResearchOperation(sessionId, operation.operationId);
      applyOperation(outcome.operation);
      setNotices((current) => ({
        ...current,
        [operation.operationId]: {
          operationId: operation.operationId,
          text: !outcome.requested
            ? t("localResearch.stopAlreadyEnded")
            : outcome.confirmed
              ? t("localResearch.stopConfirmedNotice")
              : t("localResearch.stopRequestedNotice"),
          tone: !outcome.requested || outcome.confirmed ? "done" : "waiting",
        },
      }));
    } catch {
      setNotices((current) => ({
        ...current,
        [operation.operationId]: {
          operationId: operation.operationId,
          text: t("localResearch.stopFailed"),
          tone: "failed",
        },
      }));
    } finally {
      setBusy(undefined);
    }
  };

  const retry = async (operation: ResearchOperation): Promise<void> => {
    setBusy({ action: "retry", operationId: operation.operationId });
    try {
      const updated = await client.retryResearchDelivery(sessionId, operation.operationId);
      applyOperation(updated);
      if (updated.delivery.state === "delivered") {
        deliveredSeen.current.add(updated.operationId);
        onDeliveredRef.current?.();
      }
      setNotices((current) => ({
        ...current,
        [operation.operationId]: {
          operationId: operation.operationId,
          text: updated.delivery.state === "delivered"
            ? t("localResearch.retryDelivered")
            : t("localResearch.retryStillFailed"),
          tone: updated.delivery.state === "delivered" ? "done" : "failed",
        },
      }));
    } catch {
      setNotices((current) => ({
        ...current,
        [operation.operationId]: {
          operationId: operation.operationId,
          text: t("localResearch.retryFailed"),
          tone: "failed",
        },
      }));
    } finally {
      setBusy(undefined);
    }
  };

  const response = loaded?.sessionId === sessionId ? loaded.response : undefined;
  if (!response) {
    return null; // Loading, failures and a previous Session's data stay invisible.
  }
  if (!response.enabled) {
    return null; // Disabled mode must not show a misleading enabled label.
  }

  const numbered = response.operations.map((operation, index) => ({ operation, ordinal: index + 1 }));
  const visible = (showAll ? numbered : numbered.slice(-3)).slice().reverse();

  return <section aria-label={t("localResearch.aria")} className="research-operation-panel">
    <header>
      <span>
        <strong>{t("localResearch.title")}</strong>
        <small>{t("localResearch.scope")}</small>
      </span>
      {error ? <span className="research-operation-error" role="status">{t("localResearch.unavailable")}</span> : null}
    </header>
    {response.operations.length === 0
      ? <p className="research-operation-empty">{t("localResearch.none")}</p>
      : <ul>{visible.map(({ operation, ordinal }) => renderOperation(operation, ordinal))}</ul>}
    {numbered.length > 3
      ? <footer><button className="link-button" onClick={() => setShowAll((current) => !current)} type="button">
        {showAll ? t("localResearch.showLatest") : t("localResearch.showAll", { count: numbered.length })}
      </button></footer>
      : null}
  </section>;

  function renderOperation(operation: ResearchOperation, ordinal: number): ReactNode {
    const status = researchStatus(operation);
    const stages = researchStages(operation);
    const results = deliveredResults(operation);
    const deliveryKey = deliveryLabelKey(operation);
    const continuation = researchContinuationText(operation);
    const notice = notices[operation.operationId];
    // A requested stop whose run has since become terminal is no longer
    // "waiting"; report the terminal fact instead of a stale request.
    const stopSettled = notice?.tone === "waiting" && operation.state === "stopped";
    const noticeText = notice ? (stopSettled ? t("localResearch.stopConfirmedNotice") : notice.text) : undefined;
    const noticeTone = stopSettled ? "done" : notice?.tone;
    const stopBusy = busy?.action === "stop" && busy.operationId === operation.operationId;
    const retryBusy = busy?.action === "retry" && busy.operationId === operation.operationId;
    const active = operation.state === "accepted" || operation.state === "running";
    return <li className={`research-operation ${status.tone}`} key={operation.operationId}>
      <div className="research-operation-head">
        <span className="research-operation-title" title={operation.intent}>
          <span className="research-operation-ordinal">#{ordinal}</span> {researchTitle(operation)}
        </span>
        <span aria-live="polite" className={`research-operation-status ${status.tone}`} role="status">
          {t(STATUS_KEYS[status.kind])}
        </span>
      </div>
      <div className="research-operation-meta">
        <span title={operation.engineRunId}>{operation.engineRunId}</span>
        <span title={operation.operationId}>{t("localResearch.operation", { id: shortOperationId(operation.operationId) })}</span>
        {operation.engine.phase ? <span>{operation.engine.phase}</span> : null}
      </div>
      <div className="research-operation-execution">
        {stages.count
          ? <span>{t("localResearch.stages", { count: stages.count })}</span>
          : <span>{t("localResearch.noStages")}</span>}
        {stages.latest
          ? <span>{t("localResearch.latestMetric", {
              name: stages.latest.name,
              stage: stages.latest.stageId,
              value: formatMetric(stages.latest.value),
            })}</span>
          : null}
      </div>
      <div className={`research-operation-delivery ${deliveryKey}`}>
        <span className="research-operation-delivery-label">{t("localResearch.delivery")}</span>
        <span>{t(`localResearch.delivery.${deliveryKey}` as "localResearch.delivery.pending")}</span>
        {deliveryDetail(operation) ? <span className="research-operation-delivery-detail">{deliveryDetail(operation)}</span> : null}
      </div>
      {results.solution || results.note || operation.delivery.staged?.length || operation.delivery.researcher?.length
        ? <div className="research-operation-outputs">
          {results.solution ? <button className="link-button" onClick={() => onOpenArtifact(solutionRef(operation)!)} type="button">
            {t("localResearch.openSolution", { version: results.solution.version })}
          </button> : null}
          {results.note ? <button className="link-button" onClick={() => onOpenArtifact(noteRef(operation)!)} type="button">
            {t("localResearch.openNote", { version: results.note.version })}
          </button> : null}
          {operation.delivery.staged?.length
            ? <span>{t("localResearch.deliveredAttempts", { count: operation.delivery.staged.length })}</span>
            : null}
          {operation.delivery.researcher?.length
            ? <span>{t("localResearch.researcherRecords", { count: operation.delivery.researcher.length })}</span>
            : null}
        </div>
        : null}
      {operation.error
        ? <p className="research-operation-error" role="status">{operation.error.message}</p>
        : null}
      {operation.stop.lastError
        ? <p className="research-operation-error" role="status">{operation.stop.lastError}</p>
        : null}
      {notice && notice.operationId === operation.operationId
        ? <p className={`research-operation-notice ${noticeTone ?? "waiting"}`} role="status">{noticeText}</p>
        : null}
      <div className="research-operation-actions">
        {active
          ? <button className="secondary-button compact-button" disabled={readOnly || stopBusy} onClick={() => void stop(operation)} type="button">
            {stopBusy ? t("localResearch.stopping") : t("localResearch.stop")}
          </button>
          : operation.state === "stopping"
            ? <button className="secondary-button compact-button" disabled type="button">{t("localResearch.stopping")}</button>
            : null}
        {operation.delivery.state === "failed" && !active
          ? <button className="secondary-button compact-button" disabled={readOnly || retryBusy} onClick={() => void retry(operation)} type="button">
            {retryBusy ? t("localResearch.retryingDelivery") : t("localResearch.retryDelivery")}
          </button>
          : null}
        {continuation
          ? <button className="secondary-button compact-button" disabled={readOnly} onClick={() => onPrefill(continuation)} title={t("localResearch.continueHint")} type="button">
            {t("localResearch.continue")}
          </button>
          : null}
      </div>
    </li>;
  }
}

function solutionRef(operation: ResearchOperation): ResearchArtifactRef | undefined {
  return operation.delivery.solution;
}

function noteRef(operation: ResearchOperation): ResearchArtifactRef | undefined {
  return operation.delivery.note;
}
