// Purpose: Provide pure provider conversation-state helpers used by the oracle worker.
// Responsibilities: Count composer attachments, normalize URLs, and track stable conversation URLs.
// Scope: Pure worker flow logic only; browser I/O and polling loops stay in run-job.mjs.
// Usage: Imported by run-job.mjs and sanity tests to validate conversation-state heuristics without driving a browser.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`; URL inputs may be malformed and must fail safely.

/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleStableValueState} OracleStableValueState */
/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleSendAcceptanceState} OracleSendAcceptanceState */
/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleStaleStopState} OracleStaleStopState */

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";
import { isChatGptComposerEntry, isChatGptStopEntry } from "./chatgpt-ui-helpers.mjs";

/** @param {string} snapshot @returns {boolean} */
export function chatGptStreamingVisible(snapshot) {
  return parseSnapshotEntries(snapshot).some(isChatGptStopEntry);
}

/**
 * Whether the bound assistant turn is still being generated.
 *
 * The composer stop control is the authority. ChatGPT labels a freshly streamed assistant turn's
 * action bar "Copy" and only renames it "Copy response" once the turn is re-rendered from
 * persistence, so no assistant-action label count is evidence that generation finished: counting
 * "Copy response" never matches a live turn (the job hangs) and matches mid-rehydration, when the
 * turn text is still partially rendered (the job captures a truncated response). `domStopButton`
 * is the DOM reading of CHATGPT_STOP_CONTROL_SELECTOR, which stays present until after the text is
 * final; the accessibility labels remain a fallback for when that markup drifts.
 *
 * @param {{ snapshot: string, domStopButton?: boolean }} args
 * @returns {boolean}
 */
export function chatGptGenerationActive({ snapshot, domStopButton }) {
  if (domStopButton === true) return true;
  return chatGptStreamingVisible(snapshot);
}

/**
 * Count nearby UI controls, not text lines: a multiline composer value can span hundreds of lines.
 * An attached file shows as a control named for it, or (current shell) only as its "Remove <file>"
 * control until the message is sent.
 * @param {string} snapshot
 * @param {string} fileLabel
 * @returns {number}
 */
export function composerFileEntryCount(snapshot, fileLabel) {
  const entries = parseSnapshotEntries(snapshot);
  const composerIndex = entries.findLastIndex(isChatGptComposerEntry);
  if (composerIndex === -1) return 0;
  const labels = new Set([fileLabel, `Remove ${fileLabel}`]);
  let count = 0;
  const end = Math.min(entries.length, composerIndex + 17);
  for (let index = Math.max(0, composerIndex - 16); index < end; index += 1) {
    if (labels.has(entries[index].label ?? "")) count += 1;
  }
  return count;
}

/**
 * @param {string | undefined} url
 * @returns {string}
 */
export function stripUrlQueryAndHash(url) {
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isConversationPathUrl(url) {
  return Boolean(conversationIdFromUrl(url));
}

/**
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
export function conversationIdFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const match = new URL(url).pathname.match(/\/(?:c|chat)\/([A-Za-z0-9-]+)$/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * @param {OracleSendAcceptanceState} before
 * @param {OracleSendAcceptanceState} after
 * @returns {boolean}
 */
export function providerSendAccepted(before, after) {
  const beforeUrlKnown = before.urlKnown !== false;
  const afterUrlKnown = after.urlKnown !== false;
  const beforeConversationId = beforeUrlKnown ? conversationIdFromUrl(before.url) : undefined;
  const afterConversationId = afterUrlKnown ? conversationIdFromUrl(after.url) : undefined;
  if (beforeUrlKnown && afterUrlKnown && afterConversationId && afterConversationId !== beforeConversationId) return true;
  if ((after.assistantCount ?? 0) > (before.assistantCount ?? 0)) return true;
  if (after.stopStreaming === true && before.stopStreaming !== true) return true;
  return false;
}

/**
 * @param {string} url
 * @param {string | undefined} previousChatUrl
 * @returns {string | undefined}
 */
export function resolveStableConversationUrlCandidate(url, previousChatUrl) {
  const normalizedUrl = stripUrlQueryAndHash(url);
  if (!normalizedUrl) return undefined;
  if (isConversationPathUrl(normalizedUrl)) return normalizedUrl;
  const normalizedPrevious = stripUrlQueryAndHash(previousChatUrl);
  return normalizedPrevious && normalizedPrevious === normalizedUrl ? normalizedUrl : undefined;
}

/**
 * @param {Partial<OracleStableValueState> | undefined} state
 * @param {string} nextValue
 * @returns {OracleStableValueState}
 */
export function nextStableValueState(state, nextValue) {
  return {
    lastValue: nextValue,
    stableCount: state?.lastValue === nextValue ? (state?.stableCount ?? 0) + 1 : 1,
  };
}

/**
 * Track a stop control that has outlived its stream. ChatGPT's composer can keep `Stop answering`
 * mounted after `/backend-api/f/conversation` has returned 200 and the turn is fully rendered
 * (observed 2026-09-21: the stream finished at t+14 s, the control stayed for 31 minutes). The
 * control stays the authority for "finished", so the caller never completes on such a turn
 * directly; once the bound turn's text has been non-empty and unchanged for `staleAfterMs` with
 * the control still present, the caller reloads the conversation, which re-renders the committed
 * turn without the stale control (or with a live one, if generation really is still running).
 * Empty text never ages: a long thinking phase legitimately shows the control with no text.
 * @param {Partial<OracleStaleStopState> | undefined} state
 * @param {{ stopControl: boolean; text: string; now: number; staleAfterMs: number }} input
 * @returns {OracleStaleStopState}
 */
export function nextStaleStopState(state, { stopControl, text, now, staleAfterMs }) {
  if (!stopControl || !text) return { text: "", since: undefined, stale: false };
  const since = state?.text === text && typeof state.since === "number" ? state.since : now;
  return { text, since, stale: now - since >= staleAfterMs };
}
