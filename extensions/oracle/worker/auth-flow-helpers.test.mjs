import assert from "node:assert/strict";
import test from "node:test";

import { classifyChatAuthPage, isAuthNavigationError, normalizeLoginProbeResult } from "./auth-flow-helpers.mjs";

const base = {
  url: "https://chatgpt.com/",
  snapshot: "",
  signals: { text: "", composerPresent: false },
  allowedOrigins: ["https://chatgpt.com"],
  cookieSourceLabel: "configured Chrome profile",
  runtimeProfileDir: "/tmp/oracle-runtime-test",
  logPath: "/tmp/oracle-auth-test.log",
};

test("a lone allowed-origin 403 settles instead of claiming logged-out auth", () => {
  assert.deepEqual(
    classifyChatAuthPage({ ...base, probe: { ok: false, status: 403 } }),
    {
      state: "unknown",
      message: "ChatGPT page state is not yet ready. Logs: /tmp/oracle-auth-test.log",
    },
  );
});

test("explicit authentication evidence remains terminal", () => {
  assert.equal(
    classifyChatAuthPage({ ...base, probe: { ok: false, status: 401 } }).state,
    "login_required",
  );
  assert.equal(
    classifyChatAuthPage({
      ...base,
      probe: { ok: false, status: 403, domLoginCta: true },
    }).state,
    "login_required",
  );
});

test("Cloudflare verification may settle but a blocking challenge remains distinct", () => {
  assert.equal(
    classifyChatAuthPage({
      ...base,
      signals: { text: "Verification successful. Waiting for chatgpt.com to respond. Cloudflare", composerPresent: false },
      probe: { ok: false, status: 403 },
    }).state,
    "unknown",
  );
  assert.equal(
    classifyChatAuthPage({
      ...base,
      signals: { text: "Cloudflare: verify you are human", composerPresent: false },
      probe: { ok: false, status: 403 },
    }).state,
    "challenge_blocking",
  );
});

test("an anonymous ua-* visitor beside login controls is signed out, never an account to resolve", () => {
  // /backend-api/me answers 200 with a ua-* id for a logged-out visitor.
  const probe = (fields) => normalizeLoginProbeResult({ ok: false, status: 200, bodyHasId: true, ...fields });
  for (const signal of [{ domLoginCta: true }, { onAuthPage: true }]) {
    assert.equal(classifyChatAuthPage({ ...base, probe: probe({ bodyIsAnonymous: true, ...signal }) }).state, "login_required");
  }
  assert.equal(classifyChatAuthPage({ ...base, probe: probe({ onAuthPage: true }) }).state, "auth_transitioning");
});

test("only CDP navigation interruptions make an auth read retryable", () => {
  for (const message of ["Execution context was destroyed, most likely because of a navigation.", "Inspected target navigated or closed", "Cannot find context with specified id"]) {
    assert.equal(isAuthNavigationError(new Error(message)), true, message);
  }
  for (const message of ["The isolated oracle browser was closed before auth verification completed.", "agent-browser timed out after 30000ms"]) {
    assert.equal(isAuthNavigationError(new Error(message)), false, message);
  }
});


test("prompt and sidebar phrases are not authentication challenges", () => {
  const snapshot = '- textbox "Chat with ChatGPT" [ref=e1]: rate limit Too many requests\n  upload failed could not upload\n  Something went wrong\n- link "Cloudflare captcha notes" [ref=e2]\n  - button "More options" [ref=e3]\n- button "Add files and more" [ref=e4]\n- button "Send prompt" [ref=e5]';
  assert.equal(classifyChatAuthPage({ ...base, snapshot, probe: { status: 200, bodyHasId: true } }).state, "authenticated_and_ready");
});
