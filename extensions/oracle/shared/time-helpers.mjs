// Purpose: Tiny shared time helpers for job timestamps and polling loops.

/** @param {number} ms @returns {Promise<void>} */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseTimestamp(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
