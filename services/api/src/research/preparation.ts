// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ResearchWorkObservation<T> = {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Null means unobservable; callers must retain the unknown status. */
  readonly elapsedSeconds: number | null;
} & ({ readonly outcome: "succeeded"; readonly value: T }
  | { readonly outcome: "failed"; readonly error: unknown });

/** Account for preparation/probing even when no executable task was created. */
export async function observeResearchPreparation<T>(options: {
  now(): string;
  work(): Promise<T>;
  record(observation: ResearchWorkObservation<T>): void;
}): Promise<T> {
  const startedAt = options.now();
  let result: { outcome: "succeeded"; value: T } | { outcome: "failed"; error: unknown };
  try { result = { outcome: "succeeded", value: await options.work() }; }
  catch (error) { result = { outcome: "failed", error }; }
  const finishedAt = options.now();
  const start = Date.parse(startedAt), finish = Date.parse(finishedAt);
  const elapsedSeconds = Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? (finish - start) / 1000 : null;
  options.record({ ...result, startedAt, finishedAt, elapsedSeconds });
  if (result.outcome === "failed") throw result.error;
  return result.value;
}

/** A private workspace exists only while preparation runs, including failed probes. */
export async function withResearchPreparationWorkspace<T>(parent: string, work: (root: string) => Promise<T>): Promise<T> {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const root = await mkdtemp(join(parent, ".prepare-"));
  try { return await work(root); }
  finally { await rm(root, { force: true, recursive: true }).catch(() => undefined); }
}
