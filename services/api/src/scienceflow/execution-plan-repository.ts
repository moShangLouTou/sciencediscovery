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
 * Control-plane persistence for immutable ScienceFlow execution plans.
 *
 * The table joins the API's existing `catalog.sqlite` additively, so an older
 * data directory upgrades in place. Only the whitelisted contract and the
 * reduced check results are stored: raw YAML, manifest text, host paths, and
 * descriptions are never copied here.
 *
 * The contract is written once and never updated. A preflight result replaces
 * the previous one through a conditional update keyed by the row's revision, so
 * two concurrent checks cannot let the slower writer overwrite the faster one.
 * Every read re-validates the row: a corrupt or unknown-version record throws
 * instead of being silently skipped, repaired, or erased.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
  SCIENCE_FLOW_PLAN_CHECK_CODES,
  SCIENCE_FLOW_PLAN_CHECK_STATUSES,
  SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
  SCIENCE_FLOW_WORKSPACE_SOURCES,
  type ScienceFlowExecutionBudgetDto,
  type ScienceFlowExecutionPlanContractDto,
  type ScienceFlowExecutionPlanDto,
  type ScienceFlowPlanCheckCode,
  type ScienceFlowPlanCheckDto,
  type ScienceFlowPlanCheckStatus,
  type ScienceFlowPreflightDto,
} from "@sciencediscovery/schema";

import {
  SCIENCE_FLOW_EXECUTION_BLOCKERS,
  describeScienceFlowCheck,
  digestScienceFlowContract,
} from "./execution-contract.js";

interface PlanRow {
  id: string;
  project_id: string;
  session_id: string;
  request_id: string;
  profile_id: string;
  created_at: string;
  contract_digest: string;
  contract_json: string;
  preflight_json: string | null;
  preflight_checked_at: string | null;
  preflight_revision: number;
}

/** Server-generated fields plus the frozen contract of a new plan. */
export interface ScienceFlowExecutionPlanDraft {
  readonly planId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly contractDigest: string;
  readonly contract: ScienceFlowExecutionPlanContractDto;
}

/** One stored plan and the revision of its latest preflight. */
export interface ScienceFlowStoredExecutionPlan {
  readonly plan: ScienceFlowExecutionPlanDto;
  /** Monotonic per plan; `savePreflight` compares it before writing. */
  readonly preflightRevision: number;
}

/** A stored row that does not satisfy this module's contract. Never repaired. */
export class ScienceFlowExecutionPlanCorruptError extends Error {
  constructor() {
    super("Stored ScienceFlow execution plan is unreadable");
    this.name = "ScienceFlowExecutionPlanCorruptError";
  }
}

/** The subset of the repository the service and its tests use. */
export interface ScienceFlowExecutionPlanStore {
  create(draft: ScienceFlowExecutionPlanDraft): {
    readonly created: boolean;
    readonly stored: ScienceFlowStoredExecutionPlan;
  };
  list(
    projectId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): ScienceFlowStoredExecutionPlan[];
  get(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredExecutionPlan | undefined;
  /**
   * The idempotency identity lookup. Used before any source file is read so a
   * retry cannot freeze different content under an existing `requestId`.
   */
  findByRequest(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): ScienceFlowStoredExecutionPlan | undefined;
  /**
   * Conditional preflight write: only the writer that observed
   * `expectedRevision` may replace it. Returns the row as it stands now, so a
   * losing writer sees the persisted winner rather than its discarded result.
   */
  savePreflight(
    projectId: string,
    sessionId: string,
    planId: string,
    expectedRevision: number,
    preflight: ScienceFlowPreflightDto,
  ): { readonly saved: boolean; readonly stored: ScienceFlowStoredExecutionPlan };
}

export class ScienceFlowExecutionPlanRepository
  implements ScienceFlowExecutionPlanStore
{
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS science_flow_execution_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        preflight_json TEXT,
        preflight_checked_at TEXT,
        preflight_revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS science_flow_execution_plans_session
        ON science_flow_execution_plans(session_id);
      CREATE INDEX IF NOT EXISTS science_flow_execution_plans_project
        ON science_flow_execution_plans(project_id);
      CREATE INDEX IF NOT EXISTS science_flow_execution_plans_request
        ON science_flow_execution_plans(project_id, session_id, request_id);
    `);
  }

  /**
   * Insert-or-return-existing keyed by `(projectId, sessionId, requestId)`.
   * The insert and the read-back share one synchronous connection, so a
   * concurrent retry cannot split them. A storage failure throws.
   */
  create(draft: ScienceFlowExecutionPlanDraft): {
    readonly created: boolean;
    readonly stored: ScienceFlowStoredExecutionPlan;
  } {
    const contractJson = JSON.stringify(draft.contract);
    const result = this.database
      .prepare(
        `INSERT INTO science_flow_execution_plans
           (id, project_id, session_id, request_id, profile_id, created_at,
            contract_digest, contract_json, preflight_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(project_id, session_id, request_id) DO NOTHING`,
      )
      .run(
        draft.planId,
        draft.projectId,
        draft.sessionId,
        draft.requestId,
        draft.profileId,
        draft.createdAt,
        draft.contractDigest,
        contractJson,
      );
    const row = this.selectByRequest(
      draft.projectId,
      draft.sessionId,
      draft.requestId,
    );
    if (!row) throw new ScienceFlowExecutionPlanCorruptError();
    return { created: Number(result.changes) === 1, stored: parseRow(row) };
  }

  list(
    projectId: string,
    sessionId: string,
    limit: number,
    offset: number,
  ): ScienceFlowStoredExecutionPlan[] {
    const rows = this.database
      .prepare(
        `SELECT ${PLAN_COLUMNS}
           FROM science_flow_execution_plans
          WHERE project_id = ? AND session_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(projectId, sessionId, limit, offset) as unknown as PlanRow[];
    return rows.map(parseRow);
  }

  get(
    projectId: string,
    sessionId: string,
    planId: string,
  ): ScienceFlowStoredExecutionPlan | undefined {
    const row = this.database
      .prepare(
        `SELECT ${PLAN_COLUMNS}
           FROM science_flow_execution_plans
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(planId, projectId, sessionId) as PlanRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  findByRequest(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): ScienceFlowStoredExecutionPlan | undefined {
    const row = this.selectByRequest(projectId, sessionId, requestId);
    return row ? parseRow(row) : undefined;
  }

  savePreflight(
    projectId: string,
    sessionId: string,
    planId: string,
    expectedRevision: number,
    preflight: ScienceFlowPreflightDto,
  ): { readonly saved: boolean; readonly stored: ScienceFlowStoredExecutionPlan } {
    if (
      preflight.planId !== planId ||
      preflight.schemaVersion !== SCIENCE_FLOW_PREFLIGHT_DTO_VERSION
    ) {
      throw new ScienceFlowExecutionPlanCorruptError();
    }
    const reduced = reducePreflight(preflight);
    const result = this.database
      .prepare(
        `UPDATE science_flow_execution_plans
            SET preflight_json = ?, preflight_checked_at = ?,
                preflight_revision = preflight_revision + 1
          WHERE id = ? AND project_id = ? AND session_id = ?
            AND contract_digest = ? AND preflight_revision = ?`,
      )
      .run(
        JSON.stringify(reduced),
        preflight.checkedAt,
        planId,
        projectId,
        sessionId,
        preflight.contractDigest,
        expectedRevision,
      );
    const row = this.database
      .prepare(
        `SELECT ${PLAN_COLUMNS}
           FROM science_flow_execution_plans
          WHERE id = ? AND project_id = ? AND session_id = ?`,
      )
      .get(planId, projectId, sessionId) as PlanRow | undefined;
    if (!row) throw new ScienceFlowExecutionPlanCorruptError();
    return { saved: Number(result.changes) === 1, stored: parseRow(row) };
  }

  /** Removes every plan owned by a Session (Session or Project delete). */
  deleteSession(sessionId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_execution_plans WHERE session_id = ?")
      .run(sessionId);
  }

  /** Removes every plan owned by a Project, guarding against orphans. */
  deleteProject(projectId: string): void {
    this.database
      .prepare("DELETE FROM science_flow_execution_plans WHERE project_id = ?")
      .run(projectId);
  }

  private selectByRequest(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): PlanRow | undefined {
    return this.database
      .prepare(
        `SELECT ${PLAN_COLUMNS}
           FROM science_flow_execution_plans
          WHERE project_id = ? AND session_id = ? AND request_id = ?`,
      )
      .get(projectId, sessionId, requestId) as PlanRow | undefined;
  }
}

const PLAN_COLUMNS = `id, project_id, session_id, request_id, profile_id,
  created_at, contract_digest, contract_json, preflight_json,
  preflight_checked_at, preflight_revision`;

/** The reduced preflight actually stored: descriptions are rebuilt on read. */
type StoredPreflight = {
  readonly observedContractDigest: string | null;
  readonly checkedAt: string;
  readonly outcome: "passed" | "blocked";
  readonly checks: readonly { readonly code: ScienceFlowPlanCheckCode; readonly status: ScienceFlowPlanCheckStatus }[];
};

function reducePreflight(preflight: ScienceFlowPreflightDto): StoredPreflight {
  return {
    observedContractDigest: preflight.observedContractDigest,
    checkedAt: preflight.checkedAt,
    outcome: preflight.outcome,
    checks: preflight.checks.map(({ code, status }) => ({ code, status })),
  };
}

function parseRow(row: PlanRow): ScienceFlowStoredExecutionPlan {
  const contract = parseContract(parseJson(row.contract_json));
  // A stored digest that no longer describes its payload means the row and its
  // contract disagree. Refuse rather than trust either side.
  if (digestScienceFlowContract(contract) !== row.contract_digest) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  if (typeof row.preflight_revision !== "number" || !Number.isSafeInteger(row.preflight_revision)) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  const latestPreflight =
    row.preflight_json === null
      ? parseAbsentPreflight(row)
      : parseStoredPreflight(row);
  const plan: ScienceFlowExecutionPlanDto = Object.freeze({
    schemaVersion: SCIENCE_FLOW_EXECUTION_PLAN_DTO_VERSION,
    planId: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    requestId: row.request_id,
    createdAt: row.created_at,
    contractDigest: row.contract_digest,
    contract,
    execution: Object.freeze({
      canStart: false as const,
      blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
    }),
    latestPreflight,
  });
  return Object.freeze({ plan, preflightRevision: row.preflight_revision });
}

function parseAbsentPreflight(row: PlanRow): null {
  if (
    row.preflight_revision !== 0 ||
    row.preflight_checked_at !== null
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  return null;
}

function parseStoredPreflight(row: PlanRow): ScienceFlowPreflightDto {
  if (row.preflight_json === null) throw new ScienceFlowExecutionPlanCorruptError();
  if (row.preflight_revision < 1) throw new ScienceFlowExecutionPlanCorruptError();
  const value = parseJson(row.preflight_json);
  if (!isRecord(value)) throw new ScienceFlowExecutionPlanCorruptError();
  const observedContractDigest = value.observedContractDigest;
  const checkedAt = value.checkedAt;
  const outcome = value.outcome;
  if (
    (observedContractDigest !== null &&
      (typeof observedContractDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(observedContractDigest))) ||
    typeof checkedAt !== "string" ||
    checkedAt.trim().length === 0 ||
    checkedAt !== row.preflight_checked_at ||
    (outcome !== "passed" && outcome !== "blocked")
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  const checks = parseStoredChecks(value.checks);
  // The stored outcome must still follow from the stored checks; a row that
  // says `passed` while carrying a blocking check is corrupt.
  const blocked = checks.some(
    (check) => check.status === "failed" || check.status === "unsupported",
  );
  if (blocked !== (outcome === "blocked")) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  return Object.freeze({
    schemaVersion: SCIENCE_FLOW_PREFLIGHT_DTO_VERSION,
    planId: row.id,
    contractDigest: row.contract_digest,
    observedContractDigest,
    checkedAt,
    outcome,
    canStart: false as const,
    checks,
    blockers: SCIENCE_FLOW_EXECUTION_BLOCKERS,
  });
}

function parseStoredChecks(value: unknown): readonly ScienceFlowPlanCheckDto[] {
  if (!Array.isArray(value)) throw new ScienceFlowExecutionPlanCorruptError();
  const seen = new Set<ScienceFlowPlanCheckCode>();
  const checks = value.map((entry: unknown): ScienceFlowPlanCheckDto => {
    if (!isRecord(entry)) throw new ScienceFlowExecutionPlanCorruptError();
    const code = entry.code;
    const status = entry.status;
    if (
      typeof code !== "string" ||
      !(SCIENCE_FLOW_PLAN_CHECK_CODES as readonly string[]).includes(code) ||
      typeof status !== "string" ||
      !(SCIENCE_FLOW_PLAN_CHECK_STATUSES as readonly string[]).includes(status) ||
      seen.has(code as ScienceFlowPlanCheckCode)
    ) {
      throw new ScienceFlowExecutionPlanCorruptError();
    }
    seen.add(code as ScienceFlowPlanCheckCode);
    // Descriptions are a pure function of code and status, so the fixed text is
    // rebuilt here instead of trusting stored prose.
    return Object.freeze({
      code: code as ScienceFlowPlanCheckCode,
      status: status as ScienceFlowPlanCheckStatus,
      description: describeScienceFlowCheck(
        code as ScienceFlowPlanCheckCode,
        status as ScienceFlowPlanCheckStatus,
      ),
    });
  });
  return Object.freeze(checks) as readonly ScienceFlowPlanCheckDto[];
}

// --- contract validation ---------------------------------------------------

function parseContract(value: unknown): ScienceFlowExecutionPlanContractDto {
  if (!isRecord(value)) throw new ScienceFlowExecutionPlanCorruptError();

  const scienceflow = value.scienceflow;
  if (
    !isRecord(scienceflow) ||
    !isDeclaredRevision(scienceflow.declaredRevision) ||
    scienceflow.verification !== "unverified"
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const task = value.task;
  if (
    !isRecord(task) ||
    !isNonBlankString(task.taskId) ||
    !isNullableNonBlankString(task.category) ||
    !isNullableNonBlankString(task.profile)
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const metric = value.metric;
  if (
    !isRecord(metric) ||
    !isNonBlankString(metric.name) ||
    typeof metric.lowerIsBetter !== "boolean" ||
    !isNullableNonBlankString(metric.type) ||
    (metric.authoritative !== null && typeof metric.authoritative !== "boolean")
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const artifact = value.artifact;
  if (
    !isRecord(artifact) ||
    !isNonBlankString(artifact.path) ||
    !isNullableNonBlankString(artifact.kind)
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const evaluator = value.evaluator;
  if (
    !isRecord(evaluator) ||
    !isNonBlankString(evaluator.entrypoint) ||
    !isNonBlankString(evaluator.path) ||
    !isNonBlankString(evaluator.function) ||
    !isDigest(evaluator.sha256) ||
    (evaluator.timeoutSec !== null && !isPositiveNumber(evaluator.timeoutSec))
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const description = value.description;
  if (
    !isRecord(description) ||
    !isNonBlankString(description.path) ||
    !isDigest(description.sha256)
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const workspace = value.workspace;
  if (!isRecord(workspace) || !isWorkspaceSource(workspace.source)) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  const budgets = parseBudgets(value.budgets);
  const unknowns = value.unknowns;
  if (
    !isRecord(unknowns) ||
    (unknowns.dataset !== "not-applicable" && unknowns.dataset !== "unknown") ||
    unknowns.environment !== "unknown" ||
    unknowns.pricing !== "unknown" ||
    unknowns.modelGateway !== "unknown" ||
    unknowns.revision !== "unverified" ||
    unknowns.dependencyClosure !== "incomplete"
  ) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }

  return Object.freeze({
    scienceflow: Object.freeze({
      declaredRevision: scienceflow.declaredRevision,
      verification: "unverified" as const,
    }),
    task: Object.freeze({
      taskId: task.taskId,
      category: task.category,
      profile: task.profile,
    }),
    metric: Object.freeze({
      name: metric.name,
      lowerIsBetter: metric.lowerIsBetter,
      type: metric.type,
      authoritative: metric.authoritative,
    }),
    artifact: Object.freeze({ path: artifact.path, kind: artifact.kind }),
    evaluator: Object.freeze({
      entrypoint: evaluator.entrypoint,
      path: evaluator.path,
      function: evaluator.function,
      sha256: evaluator.sha256,
      timeoutSec: evaluator.timeoutSec,
    }),
    description: Object.freeze({
      path: description.path,
      sha256: description.sha256,
    }),
    workspace: Object.freeze({
      source: workspace.source,
    }),
    taskYamlSha256: requireDigest(value.taskYamlSha256),
    manifestSha256: requireDigest(value.manifestSha256),
    sharedDefaultsSha256:
      value.sharedDefaultsSha256 === null
        ? null
        : requireDigest(value.sharedDefaultsSha256),
    budgets,
    unknowns: Object.freeze({
      dataset: unknowns.dataset,
      environment: "unknown" as const,
      pricing: "unknown" as const,
      modelGateway: "unknown" as const,
      revision: "unverified" as const,
      dependencyClosure: "incomplete" as const,
    }),
  });
}

function parseBudgets(
  value: unknown,
): readonly ScienceFlowExecutionBudgetDto[] {
  if (!Array.isArray(value)) throw new ScienceFlowExecutionPlanCorruptError();
  const seen = new Set<string>();
  const budgets = value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      throw new ScienceFlowExecutionPlanCorruptError();
    }
    if (
      (entry.name !== "wall_clock_budget_sec" && entry.name !== "time_limit") ||
      !isPositiveNumber(entry.value) ||
      entry.unit !== "seconds" ||
      entry.nature !== "requested" ||
      seen.has(entry.name)
    ) {
      throw new ScienceFlowExecutionPlanCorruptError();
    }
    seen.add(entry.name);
    return Object.freeze({
      name: entry.name,
      value: entry.value,
      unit: "seconds" as const,
      nature: "requested" as const,
    });
  });
  return Object.freeze(budgets);
}

// --- small helpers ---------------------------------------------------------

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ScienceFlowExecutionPlanCorruptError();
  }
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The declared engine revision is a full lowercase git commit id, not a digest. */
function isDeclaredRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** The source is one of the keys the engine resolves a workspace from. */
function isWorkspaceSource(
  value: unknown,
): value is ScienceFlowExecutionPlanContractDto["workspace"]["source"] {
  return (
    typeof value === "string" &&
    (SCIENCE_FLOW_WORKSPACE_SOURCES as readonly string[]).includes(value)
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
