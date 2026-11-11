// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

const retained = new Set<ProcessTerminationUnverifiedError>();

/** Owns deferred cleanup even after the execution operation has rejected.
 * Waiting for proof never keeps an execution queue or Runner.close pending. */
export class ProcessTerminationUnverifiedError extends Error {
  readonly code = "PROCESS_TERMINATION_UNVERIFIED";
  private readonly cleanups = new Map<() => Promise<void>, string>();
  private readonly registered = new Set<() => Promise<void>>();
  private confirmed = false;
  private cleanupFailed = false;
  private flushing = false;

  constructor(message: string, options?: { cause?: unknown; termination?: Promise<void> }) {
    super(message, options);
    this.name = "ProcessTerminationUnverifiedError";
    if (options?.termination) void options.termination.then(() => {
      this.confirmed = true;
      return this.flush();
    }).catch(() => { /* No proof: this owner retains the resources and diagnostic. */ });
  }

  retain(cleanup: () => Promise<void>, label: string): void {
    if (this.registered.has(cleanup)) return;
    this.registered.add(cleanup);
    this.cleanups.set(cleanup, label);
    retained.add(this);
    if (this.confirmed) void this.flush();
  }

  diagnostic(): { resources: string[]; cleanupFailed: boolean } {
    return { resources: [...this.cleanups.values()], cleanupFailed: this.cleanupFailed };
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const attempted = new Set<() => Promise<void>>();
    try {
      for (const [cleanup, label] of this.cleanups) {
        if (attempted.has(cleanup)) continue;
        attempted.add(cleanup);
        this.cleanups.delete(cleanup);
        try { await cleanup(); }
        catch { this.cleanupFailed = true; this.cleanups.set(cleanup, label); }
      }
    } finally {
      this.flushing = false;
      if (this.cleanups.size) retained.add(this);
      else retained.delete(this);
    }
  }
}

export function retainedTerminationResources(): Array<{ resources: string[]; cleanupFailed: boolean }> {
  return [...retained].map(owner => owner.diagnostic());
}

export async function cleanupExecutionResource(
  error: unknown, cleanup: () => Promise<void>, label: string,
): Promise<void> {
  if (error instanceof ProcessTerminationUnverifiedError) {
    error.retain(cleanup, label);
    return;
  }
  try { await cleanup(); } catch { /* Preserve the execution's original outcome. */ }
}
