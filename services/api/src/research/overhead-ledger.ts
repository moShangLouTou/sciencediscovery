// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Product attribution selects records; platform accounting preserves unknown coverage. */
export interface ResearchOverhead {
  readonly outcome: "succeeded" | "failed";
  readonly wallClock: { readonly status: "known" | "unknown"; readonly seconds: number };
  readonly probe: { readonly status: "known" | "unknown"; readonly evaluations: number };
}
export function summarizeResearchOverhead(records: readonly ResearchOverhead[]) {
  return {
    attempts: records.length,
    succeeded: records.filter((row) => row.outcome === "succeeded").length,
    failed: records.filter((row) => row.outcome === "failed").length,
    knownSeconds: records.reduce((sum, row) => sum + (row.wallClock.status === "known" ? row.wallClock.seconds : 0), 0),
    unknown: records.filter((row) => row.wallClock.status === "unknown").length,
    probeEvaluations: records.reduce((sum, row) => sum + (row.probe.status === "known" ? row.probe.evaluations : 0), 0),
    unknownProbes: records.filter((row) => row.probe.status === "unknown").length,
  };
}
export interface ResearchUsageSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly unknownUsageCalls: number;
  readonly status: "known" | "unknown" | "partially-known" | "not-recorded";
}
function usageStatus(calls: number, unknown: number): ResearchUsageSummary["status"] {
  return calls === 0 ? "not-recorded" : unknown >= calls ? "unknown" : unknown > 0 ? "partially-known" : "known";
}
/** Missing provider usage remains unknown, never a measured zero. */
export function captureResearchUsage(rows: readonly {
  readonly usageStatus: string; readonly inputTokens: number | null; readonly outputTokens: number | null;
}[]): ResearchUsageSummary {
  const known = rows.filter((row) => row.usageStatus === "reported" && row.inputTokens !== null && row.outputTokens !== null);
  const unknownUsageCalls = rows.length - known.length;
  return { calls: rows.length, status: usageStatus(rows.length, unknownUsageCalls), unknownUsageCalls,
    inputTokens: known.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: known.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0) };
}
export function summarizeResearchUsage(observations: readonly ResearchUsageSummary[]): ResearchUsageSummary {
  const rows = observations.filter((row) => row.status !== "not-recorded");
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const unknownUsageCalls = rows.reduce((sum, row) => sum + row.unknownUsageCalls, 0);
  return { calls, unknownUsageCalls, status: rows.length === 0 ? "not-recorded" : calls === 0 ? "unknown" : usageStatus(calls, unknownUsageCalls),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0) };
}
