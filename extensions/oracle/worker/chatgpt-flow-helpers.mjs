// Purpose: Provide pure provider conversation-state helpers used by the oracle worker.
// Responsibilities: Slice assistant snapshots, count composer attachments, normalize URLs, and track stable conversation URLs.
// Scope: Pure worker flow logic only; browser I/O and polling loops stay in run-job.mjs.
// Usage: Imported by run-job.mjs and sanity tests to validate conversation-state heuristics without driving a browser.
// Invariants/Assumptions: Snapshot text comes from agent-browser `snapshot -i`; URL inputs may be malformed and must fail safely.

/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleStableValueState} OracleStableValueState */
/** @typedef {import("./chatgpt-flow-helpers.d.mts").OracleSendAcceptanceState} OracleSendAcceptanceState */

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";

/** @param {string} snapshot @returns {boolean} */
export function chatGptStreamingVisible(snapshot) {
  return parseSnapshotEntries(snapshot).some((entry) => entry.kind === "button" && !entry.disabled
    && /^(?:Stop answering|Stop streaming|Stop generating)$/.test(entry.label || ""));
}

/**
 * Whether the bound assistant turn is still being generated.
 *
 * The composer stop control is the authority. ChatGPT labels a freshly streamed assistant turn's
 * action bar "Copy" and only renames it "Copy response" once the turn is re-rendered from
 * persistence, so no assistant-action label count is evidence that generation finished: counting
 * "Copy response" never matches a live turn (the job hangs) and matches mid-rehydration, when the
 * turn text is still partially rendered (the job captures a truncated response). `domStopButton`
 * is the `[data-testid="stop-button"]` reading, which stays present until after the text is final;
 * the accessibility labels remain a fallback for when that test id drifts.
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
 * @param {string} snapshot
 * @param {string} fileLabel
 * @param {string} composerLabel
 * @returns {number}
 */
export function composerFileEntryCount(snapshot, fileLabel, composerLabel) {
  const entries = parseSnapshotEntries(snapshot);
  const composerIndex = entries.findLastIndex((entry) => entry.kind === "textbox" && entry.label === composerLabel);
  if (composerIndex === -1) return 0;
  let count = 0;
  const end = Math.min(entries.length, composerIndex + 17);
  for (let index = Math.max(0, composerIndex - 16); index < end; index += 1) {
    if (entries[index].label === fileLabel) count += 1;
  }
  return count;
}

/**
 * @param {string} snapshot
 * @param {string} composerLabel
 * @param {number} responseIndex
 * @returns {string | undefined}
 */
export function assistantSnapshotSlice(snapshot, composerLabel, responseIndex) {
  const lines = snapshot.split("\n");
  const assistantHeadingIndices = lines.flatMap((line, index) => (line.includes('heading "ChatGPT said:"') ? [index] : []));
  const startIndex = assistantHeadingIndices[responseIndex];
  if (startIndex === undefined) return undefined;

  const endCandidates = [];
  const nextAssistantIndex = assistantHeadingIndices[responseIndex + 1];
  if (nextAssistantIndex !== undefined) endCandidates.push(nextAssistantIndex);

  const composerIndex = lines.findIndex(
    (line, index) => index > startIndex && line.includes(`textbox "${composerLabel}"`),
  );
  if (composerIndex !== -1) endCandidates.push(composerIndex);

  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : undefined;
  return lines.slice(startIndex, endIndex).join("\n");
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
