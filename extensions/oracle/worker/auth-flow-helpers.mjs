// Purpose: Provide pure auth-bootstrap classification helpers for ChatGPT browser state handling.
// Responsibilities: Normalize login-probe payloads, classify ChatGPT auth page states, and derive account chooser candidate labels.
// Scope: Pure worker/auth decision logic only; browser I/O, logging, and side effects stay in auth-bootstrap.mjs.
// Usage: Imported by auth-bootstrap.mjs and sanity tests to exercise auth classification behavior without driving a browser.
// Invariants/Assumptions: Inputs are already captured snapshots/probe results from the live browser session; outputs are deterministic and side-effect free.

import { detectProviderSignals } from "./provider-page-signals.mjs";
import { snapshotHasUsableComposerControls } from "./chatgpt-ui-helpers.mjs";

/** @typedef {import("./auth-flow-helpers.d.mts").OracleAuthLoginProbe} OracleAuthLoginProbe */
/** @typedef {import("./auth-flow-helpers.d.mts").OracleAuthPageClassification} OracleAuthPageClassification */

/**
 * @param {unknown} result
 * @returns {OracleAuthLoginProbe}
 */
export function normalizeLoginProbeResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, status: 0, error: "invalid-probe-result" };
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  return {
    ok: value.ok === true,
    status: typeof value.status === "number" ? value.status : 0,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : undefined,
    domLoginCta: value.domLoginCta === true,
    onAuthPage: value.onAuthPage === true,
    error: typeof value.error === "string" ? value.error : undefined,
    bodyKeys: Array.isArray(value.bodyKeys) ? value.bodyKeys.filter((entry) => typeof entry === "string") : [],
    bodyHasId: value.bodyHasId === true,
    bodyHasEmail: value.bodyHasEmail === true,
    bodyIsAnonymous: value.bodyIsAnonymous === true,
    name: typeof value.name === "string" ? value.name : undefined,
    responsePreview: typeof value.responsePreview === "string" ? value.responsePreview : undefined,
  };
}

/**
 * CDP evaluations can be interrupted by normal redirects. Do not retry arbitrary
 * protocol failures or explicitly closed/disconnected browser errors.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/i.test(message);
}

/**
 * @param {string | undefined} name
 * @returns {string[]}
 */
export function buildAccountChooserCandidateLabels(name) {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) return [];
  const firstToken = normalized.split(/\s+/)[0] || "";
  return firstToken && firstToken !== normalized ? [normalized, firstToken] : [normalized];
}

/**
 * @param {{
 *   url: string;
 *   snapshot: string;
 *   signals: import("./provider-page-signals.d.mts").ProviderPageSignals;
 *   probe?: OracleAuthLoginProbe;
 *   allowedOrigins: readonly string[];
 *   cookieSourceLabel: string;
 *   runtimeProfileDir: string;
 *   logPath: string;
 * }} args
 * @returns {OracleAuthPageClassification}
 */
export function classifyChatAuthPage(args) {
  const detected = detectProviderSignals(args);
  const onAllowedOrigin = args.allowedOrigins.some((origin) => args.url.startsWith(origin));
  const hasUsableComposer = snapshotHasUsableComposerControls(args.snapshot);

  if (detected.challenge) {
    if (detected.challenge === "settling") {
      return { state: "unknown", message: "ChatGPT verification is still settling." };
    }
    return {
      state: "challenge_blocking",
      message:
        `ChatGPT challenge detected after syncing cookies from ${args.cookieSourceLabel}. ` +
        `The isolated oracle browser was left open on profile ${args.runtimeProfileDir}; complete the challenge there, then rerun /oracle-auth. Logs: ${args.logPath}`,
    };
  }

  if (detected.headerTooLarge) {
    return {
      state: "login_required",
      message:
        `Imported auth hit HTTP 431 during ChatGPT auth resolution, which usually means the imported cookie set is too large or stale. ` +
        `Inspect ${args.logPath}.`,
    };
  }

  if (detected.transient) {
    return { state: "transient_outage_error", message: `ChatGPT is showing a transient outage/error page. Logs: ${args.logPath}` };
  }

  // /backend-api/me also returns HTTP 200 and an id for anonymous visitors.
  // Those ua-* identities must not drive account selection or auth reloads.
  if (args.probe?.bodyIsAnonymous && (args.probe?.onAuthPage || args.probe?.domLoginCta)) {
    return {
      state: "login_required",
      message:
        `Synced cookies from ${args.cookieSourceLabel}, but ChatGPT returned an anonymous visitor session, not a signed-in account. ` +
        `Sign in to ChatGPT in the source browser profile, quit that browser, then rerun /oracle-auth. Logs: ${args.logPath}`,
    };
  }

  const probeHasAccountIdentity = !args.probe?.bodyIsAnonymous && (args.probe?.bodyHasId === true || args.probe?.bodyHasEmail === true);

  // Cloudflare can make /backend-api/me return 403 before its challenge body or
  // the authenticated composer becomes observable. Only 401 is conclusive here;
  // explicit auth-page and login-control evidence is handled below.
  if (args.probe?.status === 401) {
    return {
      state: "login_required",
      message:
        `Synced cookies from ${args.cookieSourceLabel}, but ChatGPT still rejected the session ` +
        `(status=${args.probe?.status ?? 0}); the cookie DB may be stale, from the wrong browser profile, or for an account that is logged out. ` +
        `Check auth.chromeProfile/auth.chromeCookiePath/auth.chromiumKeychain and inspect ${args.logPath}.`,
    };
  }

  if (args.probe?.onAuthPage) {
    if (probeHasAccountIdentity) {
      return {
        state: "auth_transitioning",
        message:
          `ChatGPT is on /auth/login, but /backend-api/me returned a partial authenticated session. ` +
          `Trying to drive the login resolution flow. Logs: ${args.logPath}`,
      };
    }
    return {
      state: "login_required",
      message:
        `Synced cookies from ${args.cookieSourceLabel}, but ChatGPT still rejected the session ` +
        `(status=${args.probe?.status ?? 0}); the cookie DB may be stale, from the wrong browser profile, or for an account that is logged out. ` +
        `Check auth.chromeProfile/auth.chromeCookiePath/auth.chromiumKeychain and inspect ${args.logPath}.`,
    };
  }

  if (onAllowedOrigin && args.probe?.domLoginCta && !probeHasAccountIdentity) {
    return {
      state: "login_required",
      message:
        `ChatGPT still shows public login controls after syncing cookies from ${args.cookieSourceLabel}. ` +
        `The cookie DB may be stale, from the wrong browser profile, or for an account that is logged out. ` +
        `Check auth.chromeProfile/auth.chromeCookiePath/auth.chromiumKeychain and inspect ${args.logPath}.`,
    };
  }

  if (onAllowedOrigin && (args.probe?.status === 200 || args.probe?.status === 403) && hasUsableComposer) {
    if (!args.probe?.domLoginCta) {
      return {
        state: "authenticated_and_ready",
        message: `Imported ChatGPT auth from ${args.cookieSourceLabel} into the isolated oracle profile. Logs: ${args.logPath}`,
      };
    }

    // The public logged-out composer case returned above, so a remaining visible login CTA here still has account-like probe data.
    return {
      state: "auth_transitioning",
      message:
        `ChatGPT backend probe returned account-like fields, but the shell still shows public login controls. ` +
        `Trying to resolve the account shell. Logs: ${args.logPath}`,
    };
  }

  if (onAllowedOrigin && args.probe?.ok && hasUsableComposer) {
    return {
      state: "authenticated_and_ready",
      message: `Imported ChatGPT auth from ${args.cookieSourceLabel} into the isolated oracle profile. Logs: ${args.logPath}`,
    };
  }

  if (args.url && !onAllowedOrigin) {
    return { state: "login_required", message: `Imported auth redirected away from the expected ChatGPT origin. Logs: ${args.logPath}` };
  }

  return { state: "unknown", message: `ChatGPT page state is not yet ready. Logs: ${args.logPath}` };
}
