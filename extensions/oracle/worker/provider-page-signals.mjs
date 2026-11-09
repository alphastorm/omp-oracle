// Provider-owned evidence only: drafts, history, sidebar titles and links are not errors.
import { snapshotHasUsableComposerControls } from "./chatgpt-ui-helpers.mjs";

export const PROVIDER_PATTERNS = {
  challenge: [/just a moment/i, /verify you are human/i, /cloudflare/i, /captcha|turnstile|hcaptcha/i, /unusual activity/i, /suspicious activity/i],
  challengeSettling: /verification successful|waiting for chatgpt\.com to respond/i,
  transient: ["Too many requests", "rate limit", "try again later", "Something went wrong", "A network error occurred", "An error occurred while connecting to the websocket", "network error"],
  visibleBlocker: ["Too many requests", "rate limit"],
  upload: ["Failed upload", "upload failed", "files.oaiusercontent.com", "Please ensure your network settings allow access to this site", "could not upload"],
  responseFailure: ["Message delivery timed out", "A network error occurred", "An error occurred while connecting to the websocket", "There was an error generating a response", "Something went wrong while generating the response"],
  headerTooLarge: /http error 431|request header or cookie too large/i,
};

// User content in `snapshot -i`: input values and their continuation lines, links, and the sidebar, where ChatGPT
// titles a just-sent chat with the prompt itself (observed live 2026-11-09). The page-text channel excludes the same.
const SNAPSHOT_CONTENT_ROLES = ["textbox", "searchbox", "combobox", "link", "navigation", "complementary"];

/** @param {string} snapshot */
export function snapshotSignalText(snapshot) {
  const kept = [];
  let skippedIndent;
  for (const line of snapshot.split("\n")) {
    const entry = line.match(/^(\s*)- (\w+)/);
    if (skippedIndent !== undefined) {
      if (!entry || entry[1].length > skippedIndent) continue;
      skippedIndent = undefined;
    }
    if (entry && SNAPSHOT_CONTENT_ROLES.includes(entry[2])) {
      skippedIndent = entry[1].length;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** @param {{ editorSelector: string }} options */
export function providerPageSignalsExpression({ editorSelector }) {
  return `(() => {
    const visible = (node) => typeof node.checkVisibility === 'function' ? node.checkVisibility() : node.getClientRects().length > 0;
    const excluded = ${JSON.stringify('a, [role="link"], nav, aside, [role="navigation"], [role="complementary"], [data-message-author-role], article, [data-testid^="conversation-turn"], [data-turn-key], [data-chatgpt-search-message-ids], [data-chatgpt-selection-message-id], [data-message-id], .message-bubble, [contenteditable="true"], textarea, input, select, [role="textbox"], [role="combobox"], [role="searchbox"], script, style, noscript, template') } + ', ' + ${JSON.stringify(editorSelector)};
    const composerPresent = [...document.querySelectorAll(${JSON.stringify(editorSelector)})].some(visible);
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let text = '', node;
    while (text.length < 8000 && (node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || !visible(parent)) continue;
      const value = node.textContent.trim();
      if (value) text += (text ? '\\n' : '') + value;
    }
    return { text: text.slice(0, 8000), composerPresent };
  })()`;
}

/** @param {string[]} patterns @param {string} text */
function matchText(patterns, text) {
  const lower = text.toLowerCase();
  return patterns.find((pattern) => lower.includes(pattern.toLowerCase()));
}

/** @param {{ snapshot: string; signals?: import("./provider-page-signals.d.mts").ProviderPageSignals }} input
 * @returns {import("./provider-page-signals.d.mts").DetectedProviderSignals}
 */
export function detectProviderSignals({ snapshot, signals }) {
  const text = `${snapshotSignalText(snapshot)}\n${signals?.text || ""}`;
  return {
    challenge: PROVIDER_PATTERNS.challenge.some((pattern) => pattern.test(text)) ? (PROVIDER_PATTERNS.challengeSettling.test(text) ? "settling" : "blocking") : undefined,
    transient: matchText(PROVIDER_PATTERNS.transient, text),
    uploadError: matchText(PROVIDER_PATTERNS.upload, text),
    headerTooLarge: PROVIDER_PATTERNS.headerTooLarge.test(text),
  };
}

/** @param {string} snapshot */
export function visibleBlockerInSnapshot(snapshot) {
  return matchText(PROVIDER_PATTERNS.visibleBlocker, snapshotSignalText(snapshot));
}

/** @param {{ hasStopStreaming: boolean; hasRetryButton: boolean; turnText: string; readSignals: () => Promise<import("./provider-page-signals.d.mts").ProviderPageSignals | undefined> }} args */
export async function detectCompletionFailure({ hasStopStreaming, hasRetryButton, turnText, readSignals }) {
  if (hasStopStreaming || !hasRetryButton) return undefined;
  const signals = await readSignals().catch(() => undefined);
  const turn = turnText.trim();
  return matchText(PROVIDER_PATTERNS.responseFailure, `${signals?.text || ""}\n${turn.length <= 400 ? turn : ""}`);
}

/** @param {{ selection?: { provider?: string } }} job @param {string} errorText @param {string} [context] */
export function formatProviderTransientErrorMessage(job, errorText, context) {
  const providerLabel = job?.selection?.provider === "grok" ? "Grok" : "ChatGPT";
  return `${providerLabel} is showing a transient outage/rate-limit page${context ? ` while ${context}` : ""}: ${errorText}`;
}

/** @param {{ selection?: { provider?: string } }} job @param {string} snapshot @param {string} [context] */
export function providerTransientErrorMessage(job, snapshot, context) {
  const errorText = visibleBlockerInSnapshot(snapshot);
  return errorText ? formatProviderTransientErrorMessage(job, errorText, context) : "";
}

/** @param {{ selection?: { provider?: string } }} job @param {string} snapshot @param {string} [context] */
export function throwIfProviderTransientError(job, snapshot, context) {
  const message = providerTransientErrorMessage(job, snapshot, context);
  if (message) throw new Error(message);
}

/** @param {string} text */
export function hasGrokLoginCta(text) {
  return text.split("\n").some((line) => {
    const label = line.trim().match(/^-\s*(?:button|link|menuitem)\s+"([^"]+)"/i)?.[1]?.trim() || line.trim();
    return /^(?:sign in|log in|continue with x|continue with google|create account)$/i.test(label);
  });
}

/** @param {import("./provider-page-signals.d.mts").ChatGptJobPageArgs} args
 * @returns {import("./auth-flow-helpers.d.mts").OracleAuthPageClassification}
 */
export function classifyChatGptJobPage({ url, snapshot, signals, probe, allowedOrigins }) {
  const detected = detectProviderSignals({ snapshot, signals });
  if (detected.challenge === "settling") return { state: "unknown", message: "ChatGPT verification is still settling." };
  if (detected.challenge === "blocking") return { state: "challenge_blocking", message: "ChatGPT is showing a challenge/verification page" };
  if (detected.transient) return { state: "transient_outage_error", message: `ChatGPT is showing a transient outage/rate-limit page: ${detected.transient}` };

  const onAllowedOrigin = typeof url === "string" && allowedOrigins.some((origin) => url.startsWith(origin));
  const onAuthPath = typeof url === "string" && url.includes("/auth/");
  const hasUsableComposer = snapshotHasUsableComposerControls(snapshot);

  // /backend-api/me also returns HTTP 200 and an id for anonymous visitors: a ua-* identity
  // beside login controls is a signed-out page, never an account still resolving.
  if (probe?.bodyIsAnonymous && (onAuthPath || probe?.onAuthPage || probe?.domLoginCta)) {
    return {
      state: "login_required",
      message: "ChatGPT login is required: the page shows login controls and returned an anonymous visitor session, not a signed-in account. Run /oracle-auth.",
    };
  }

  const probeHasAccountIdentity = !probe?.bodyIsAnonymous && (probe?.bodyHasId === true || probe?.bodyHasEmail === true);

  // A fresh runtime can see a transient 403 while Cloudflare is still loading.
  // Require explicit authentication evidence before declaring the seed logged out.
  if (probe?.status === 401) {
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAuthPath || probe?.onAuthPage) {
    if (probeHasAccountIdentity) {
      return {
        state: "auth_transitioning",
        message: "ChatGPT is on an auth page even though the backend probe returned account-like fields. Rerun /oracle-auth.",
      };
    }
    return { state: "login_required", message: "ChatGPT login is required. Run /oracle-auth." };
  }

  if (onAllowedOrigin && probe?.domLoginCta && !probeHasAccountIdentity) {
    return {
      state: "login_required",
      message: "ChatGPT login is required: the chat shell still shows public Log in/Sign up controls. Run /oracle-auth.",
    };
  }

  if (onAllowedOrigin && (probe?.status === 200 || probe?.status === 403) && hasUsableComposer) {
    if (probe?.domLoginCta) {
      // The public logged-out composer case returned above, so a remaining visible login CTA here still has account-like probe data.
      return {
        state: "auth_transitioning",
        message: "ChatGPT backend probe returned account-like fields, but the web shell still shows public login controls. Rerun /oracle-auth.",
      };
    }
    return { state: "authenticated_and_ready", message: "ChatGPT is authenticated and ready." };
  }

  if (url && !onAllowedOrigin) {
    return { state: "login_required", message: "ChatGPT redirected away from the expected authenticated chat origin." };
  }

  return { state: "unknown", message: "ChatGPT page is not ready yet." };
}

/** @param {import("./provider-page-signals.d.mts").ProviderPageArgs} args
 * @returns {import("./auth-flow-helpers.d.mts").OracleAuthPageClassification}
 */
export function classifyGrokPage({ url, snapshot, signals }) {
  const detected = detectProviderSignals({ snapshot, signals });
  if (detected.challenge) {
    return { state: "challenge_blocking", message: "Grok is showing a challenge/verification page" };
  }
  const outageText = detected.transient;
  if (outageText) {
    return { state: "transient_outage_error", message: `Grok is showing a transient outage/rate-limit page: ${outageText}` };
  }
  const onGrokOrigin = typeof url === "string" && url.startsWith("https://grok.com");
  if (onGrokOrigin && hasGrokLoginCta(snapshot)) {
    return { state: "login_required", message: "Grok login is required. Sign in to Grok in the configured browser profile and rerun /oracle-auth grok." };
  }
  const hasComposer = snapshot.includes('button "Attach"') && (snapshot.includes('textbox "Ask Grok anything"') || snapshot.includes("contenteditable"));
  if (onGrokOrigin && hasComposer) return { state: "authenticated_and_ready", message: "Grok is ready." };
  if (url && !onGrokOrigin) return { state: "login_required", message: "Grok redirected away from grok.com. Sign in to Grok in the configured browser profile and rerun /oracle-auth grok if needed." };
  return { state: "unknown", message: "Grok page is not ready yet." };
}

/** @param {import("./provider-page-signals.d.mts").ProviderPageArgs & { cookieSourceLabel: string }} args
 * @returns {import("./auth-flow-helpers.d.mts").OracleAuthPageClassification}
 */
export function classifyGrokAuthPage({ url, snapshot, signals, cookieSourceLabel }) {
  const detected = detectProviderSignals({ snapshot, signals });
  if (detected.challenge) {
    return { state: "challenge_blocking", message: "Grok is showing a challenge/verification page" };
  }
  if (detected.transient) {
    return { state: "transient_outage_error", message: "Grok is showing a transient outage/error page" };
  }
  const onGrokOrigin = typeof url === "string" && url.startsWith("https://grok.com");
  const hasComposer = snapshot.includes('button "Attach"') && (snapshot.includes('textbox "Ask Grok anything"') || snapshot.includes("contenteditable"));
  if (onGrokOrigin && hasGrokLoginCta(snapshot)) return { state: "login_required", message: `Grok login is required. Sign in to Grok in ${cookieSourceLabel}.` };
  if (onGrokOrigin && hasComposer) return { state: "authenticated_and_ready", message: "Grok is authenticated and ready." };
  if (url && !onGrokOrigin) return { state: "login_required", message: "Grok redirected away from grok.com." };
  return { state: "unknown", message: "Grok page is not ready yet." };
}

