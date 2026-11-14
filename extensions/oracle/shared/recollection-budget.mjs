// Separate from ordinary submission: the synchronous read must outlive every worker stage.
export const RECOLLECTION_STARTUP_BUDGET_MS = 5 * 60_000;
export const RECOLLECTION_POST_WAIT_BUDGET_MS = 10 * 60_000;
export const RECOLLECTION_FINALIZE_RESERVE_MS = 60_000;
export const RECOLLECTION_READ_MARGIN_MS = 60_000;
export const RECOLLECTION_RESEARCH_WAIT_MS = 60_000;

/** @param {{ selection: { tool?: string }; config: { worker: { completionTimeoutMs: number } } }} job */
export function recollectionWaitMs(job) {
  return job.selection.tool === "deep_research" ? RECOLLECTION_RESEARCH_WAIT_MS : job.config.worker.completionTimeoutMs;
}

/** @param {Parameters<typeof recollectionWaitMs>[0]} job */
export function recollectionReadTimeoutMs(job) {
  return RECOLLECTION_STARTUP_BUDGET_MS + recollectionWaitMs(job) + RECOLLECTION_POST_WAIT_BUDGET_MS + RECOLLECTION_READ_MARGIN_MS;
}

/** @param {number | undefined} deadline @param {number} requested @param {number} [now] */
export function recollectionOperationTimeoutMs(deadline, requested, now = Date.now()) {
  if (deadline === undefined) return requested;
  const remaining = deadline - now;
  if (remaining <= 0) throw new Error("Recollection post-wait budget exhausted; remaining artifacts are unconfirmed.");
  return Math.min(requested, remaining);
}
