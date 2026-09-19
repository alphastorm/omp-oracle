import assert from "node:assert/strict";
import test from "node:test";

import { classifyChatAuthPage } from "./auth-flow-helpers.mjs";

const base = {
  url: "https://chatgpt.com/",
  snapshot: "",
  body: "",
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
      body: "Verification successful. Waiting for chatgpt.com to respond. Cloudflare",
      probe: { ok: false, status: 403 },
    }).state,
    "unknown",
  );
  assert.equal(
    classifyChatAuthPage({
      ...base,
      body: "Cloudflare: verify you are human",
      probe: { ok: false, status: 403 },
    }).state,
    "challenge_blocking",
  );
});
