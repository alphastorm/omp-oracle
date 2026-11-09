import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { classifyChatAuthPage } from "./auth-flow-helpers.mjs";
import { classifyChatGptJobPage, classifyGrokPage, classifyGrokAuthPage, detectProviderSignals, detectCompletionFailure, snapshotSignalText, visibleBlockerInSnapshot, providerPageSignalsExpression } from "./provider-page-signals.mjs";

// agent-browser 0.41.2 contenteditable snapshot shape, reproduced on a loopback-only page.
const snapshot = `- textbox "Chat with ChatGPT" [ref=e1]: rate limit Too many requests
upload failed could not upload
Something went wrong try again later
- link "Cloudflare captcha notes" [ref=e2]
  - button "rate limit menu" [ref=e3]
- button "Add files and more" [ref=e4]
- button "Send prompt" [ref=e5]`;
const base = { url: "https://chatgpt.com/", snapshot, signals: { text: "", composerPresent: true }, probe: { ok: true, status: 200, bodyHasId: true }, allowedOrigins: ["https://chatgpt.com"], cookieSourceLabel: "test Chrome", runtimeProfileDir: "/tmp/test", logPath: "/tmp/test.log" };

test("prompt and history text never classify as provider errors", () => {
  assert.equal(classifyChatGptJobPage(base).state, "authenticated_and_ready");
  assert.equal(classifyChatAuthPage(base).state, "authenticated_and_ready");
  assert.deepEqual(detectProviderSignals(base), { challenge: undefined, transient: undefined, uploadError: undefined, headerTooLarge: false });
  assert.equal(visibleBlockerInSnapshot(snapshot), undefined);
  assert.equal(classifyChatGptJobPage({ ...base, signals: { text: "Too many requests. Please try again later.", composerPresent: true } }).state, "transient_outage_error");
  assert.equal(classifyChatAuthPage({ ...base, signals: { text: "Too many requests. Please try again later.", composerPresent: true } }).state, "transient_outage_error");
  assert.equal(classifyChatGptJobPage({ ...base, signals: { text: "Just a moment… Verify you are human", composerPresent: false } }).state, "challenge_blocking");
});

test("snapshot filtering drops all input/link continuation lines but keeps error surfaces", () => {
  const input = `- dialog "Files"
  - searchbox "Search" [ref=e1]: rate limit
continued upload failed
    - button "Too many requests" [ref=e2]
  - combobox "Choose" [ref=e3]: captcha
  - alert "upload failed" [ref=e4]
- button "rate limit" [ref=e5]`;
  assert.equal(snapshotSignalText(input), '- dialog "Files"\n  - alert "upload failed" [ref=e4]\n- button "rate limit" [ref=e5]');
  assert.equal(detectProviderSignals({ snapshot: input }).uploadError, "upload failed");
  assert.equal(visibleBlockerInSnapshot(input), "rate limit");
});

test("interstitial, 431, settling and login verdicts survive filtering", () => {
  assert.equal(classifyChatGptJobPage({ ...base, signals: { text: "Cloudflare Verification successful", composerPresent: false } }).state, "unknown");
  assert.equal(classifyChatAuthPage({ ...base, signals: { text: "HTTP ERROR 431", composerPresent: false } }).state, "login_required");
  assert.equal(classifyChatGptJobPage({ ...base, probe: { status: 401 } }).state, "login_required");
  assert.equal(classifyChatGptJobPage({ ...base, probe: { status: 200, domLoginCta: true } }).state, "login_required");
  assert.equal(classifyChatAuthPage({ ...base, probe: { status: 200, domLoginCta: true } }).state, "login_required");
  const grok = { url: "https://grok.com/", snapshot: '- textbox "Ask Grok anything" [ref=e1]: cloudflare rate limit\nupload failed\n- button "Attach" [ref=e2]', signals: base.signals };
  assert.equal(classifyGrokPage(grok).state, "authenticated_and_ready");
  assert.equal(classifyGrokAuthPage({ ...grok, cookieSourceLabel: "test Chrome" }).message, "Grok is authenticated and ready.");
  assert.equal(classifyGrokPage({ ...grok, snapshot: grok.snapshot + '\n- link "Sign in" [ref=e3]' }).state, "login_required");
  assert.equal(classifyGrokAuthPage({ ...grok, cookieSourceLabel: "test Chrome", snapshot: grok.snapshot + '\n- link "Sign in" [ref=e3]' }).state, "login_required");
  assert.equal(classifyGrokPage({ ...grok, signals: { text: "network error", composerPresent: true } }).state, "transient_outage_error");
});

test("completion reads signals only for Retry without Stop and ignores long answer quotations", async () => {
  let reads = 0;
  const readSignals = async () => { reads += 1; return { text: "", composerPresent: true }; };
  for (const [hasStopStreaming, hasRetryButton] of [[true, true], [true, false], [false, false]]) {
    assert.equal(await detectCompletionFailure({ hasStopStreaming, hasRetryButton, turnText: "A network error occurred", readSignals }), undefined);
  }
  assert.equal(reads, 0);
  assert.equal(await detectCompletionFailure({ hasStopStreaming: false, hasRetryButton: true, turnText: "Message delivery timed out", readSignals }), "Message delivery timed out");
  assert.equal(await detectCompletionFailure({ hasStopStreaming: false, hasRetryButton: true, turnText: "A network error occurred", readSignals }), "A network error occurred");
  assert.equal(await detectCompletionFailure({ hasStopStreaming: false, hasRetryButton: true, turnText: "A network error occurred " + "answer ".repeat(100), readSignals }), undefined);
  assert.equal(await detectCompletionFailure({ hasStopStreaming: false, hasRetryButton: true, turnText: "", readSignals: async () => { throw new Error("navigation"); } }), undefined);
});

test("page expression excludes content surfaces, hidden text and title; caps visible evidence", () => {
  const ignored = ["a", '[role="link"]', "nav", "aside", '[role="navigation"]', '[role="complementary"]', "[data-message-author-role]", "article", '[data-testid^="conversation-turn"]', ".message-bubble", '[contenteditable="true"]', "textarea", "input", "select", '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]', "script", "style", "noscript", "template", "#editor"];
  const nodes = ignored.map((selector) => ({ textContent: "captcha rate limit upload failed", parentElement: { closest: (selectors) => selectors.split(", ").includes(selector), checkVisibility: () => true } }));
  nodes.push({ textContent: "hidden error", parentElement: { closest: () => null, checkVisibility: () => false } });
  nodes.push({ textContent: "Visible banner", parentElement: { closest: () => null, getClientRects: () => [1] } });
  nodes.push({ textContent: "x".repeat(9000), parentElement: { closest: () => null, checkVisibility: () => true } });
  let index = 0;
  const document = { body: {}, get title() { throw new Error("title must not be read"); }, querySelectorAll: () => [{ checkVisibility: () => false }, { checkVisibility: () => true }], createTreeWalker: () => ({ nextNode: () => nodes[index++] }) };
  const result = vm.runInNewContext(providerPageSignalsExpression({ editorSelector: "#editor" }), { document, NodeFilter: { SHOW_TEXT: 4 } });
  assert.equal(result.text.length, 8000);
  assert.ok(result.text.startsWith("Visible banner\nx"));
  assert.equal(result.composerPresent, true);
});
