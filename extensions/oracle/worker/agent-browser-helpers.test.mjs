import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { createAgentBrowserRunner, parseEvalResult, resolveAgentBrowserTimeoutMs, batchInvocation, AGENT_BROWSER_TIMEOUTS } from "./agent-browser-helpers.mjs";
import { composerTextDigest, composerTextDigestExpression, CHATGPT_COMPOSER_EDITOR_SELECTOR, isChatGptComposerEntry } from "./chatgpt-ui-helpers.mjs";
import { parseSnapshotEntries } from "./artifact-heuristics.mjs";

async function fakeDriver(t) {
  const dir = await mkdtemp(join(tmpdir(), "oracle-runner-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, "driver");
  const log = join(dir, "calls");
  const state = join(dir, "state");
  await writeFile(log, "");
  await writeFile(state, "success");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2); const mode = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input += s);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, input}) + '\\n');
  if (args.includes('stream')) { console.log(JSON.stringify({data: {connected: mode !== 'disconnected'}})); return; }
  if (mode === 'sleep') { setTimeout(() => {}, 10000); return; }
  if (mode !== 'success') { console.error('original click failure'); process.exitCode = 1; }
});
`, { mode: 0o700 });
  let identities = 0;
  const runner = createAgentBrowserRunner({ binary, baseArgs: () => ["--session", "unit"], beforeCommand: async () => { identities += 1; }, connectionCheckEnabled: () => true, shuttingDown: () => false, disconnectMessage: "browser disconnected" });
  return { runner, identities: () => identities, mode: (mode) => writeFile(state, mode), calls: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

test("runner success checks identity every time without status subprocesses", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  for (let i = 0; i < 3; i++) await fake.runner.run(["snapshot", "-i"]);
  assert.equal(fake.identities(), 3);
  assert.deepEqual((await fake.calls()).map((call) => call.args.slice(2)), Array(3).fill(["snapshot", "-i"]));
});

test("failed command checks status once but is never retried", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  await fake.mode("failed");
  await assert.rejects(fake.runner.run(["click", "@e1"]), /original click failure/);
  assert.deepEqual((await fake.calls()).map((call) => call.args.slice(2)), [["click", "@e1"], ["--json", "stream", "status"]]);
  assert.equal(fake.identities(), 2, "even the diagnostic command proves browser identity");
});

test("failed command attributes a confirmed disconnect", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  await fake.mode("disconnected");
  await assert.rejects(fake.runner.run(["click", "@e1"]), /browser disconnected/);
});

test("hung command has a bounded typed timeout", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  await fake.mode("sleep");
  const started = Date.now();
  await assert.rejects(fake.runner.run(["snapshot", "-i"], { timeoutMs: 200 }), (error) => error.code === "agent_browser_timeout" && error.timeoutMs === 200);
  assert.ok(Date.now() - started < 3000);
  // The fake logs a call when its stdin ends; a loaded host can kill the hung command before that,
  // so its entry is optional. The status probe runs to completion and always logs.
  const calls = (await fake.calls()).map((call) => call.args.slice(2));
  assert.ok(calls.filter((args) => args[0] === "snapshot").length <= 1, "a timed-out command is never replayed");
  assert.deepEqual(calls.filter((args) => args[0] !== "snapshot"), [["--json", "stream", "status"]], "a timeout checks the connection once");
});

test("numeric waits and shutdown never spawn; identity refusal prevents commands", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  await assert.rejects(fake.runner.run(["wait", "500"]), /must use sleep/);
  assert.deepEqual(await fake.calls(), []);
  for (const shutdown of [false, true]) {
    const runner = createAgentBrowserRunner({ binary: "must-not-spawn", baseArgs: () => [], beforeCommand: async () => { throw new Error("managed browser changed"); }, connectionCheckEnabled: () => true, shuttingDown: () => shutdown, disconnectMessage: "disconnected" });
    await assert.rejects(runner.run(["click", "@e1"]), shutdown ? /shutting down/ : /managed browser changed/);
  }
});

test("allowFailure keeps failure results without status probes", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  await fake.mode("failed");
  assert.equal((await fake.runner.run(["get", "text", "body"], { allowFailure: true })).code, 1);
  assert.equal((await fake.calls()).length, 1);
});

test("timeout overrides and clamps are deterministic", () => {
  for (const [value, expected] of [["1", 5000], ["999999", 150000], ["65000", 65000], ["12oops", 60000], ["0", 60000], ["-1", 60000]]) {
    assert.equal(resolveAgentBrowserTimeoutMs(["snapshot"], undefined, { PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS: value }), expected);
  }
  assert.equal(resolveAgentBrowserTimeoutMs(["--json", "open"], undefined, {}), 90000);
  assert.equal(resolveAgentBrowserTimeoutMs(["connect"], undefined, {}), 30000);
  assert.equal(resolveAgentBrowserTimeoutMs(["batch"], 200, {}), 200);
});

test("parseEvalResult handles undefined, null, nested JSON and plain strings", () => {
  assert.equal(parseEvalResult("  undefined\n"), undefined);
  assert.equal(parseEvalResult("null"), null);
  assert.deepEqual(parseEvalResult(JSON.stringify(JSON.stringify({ ok: true }))), { ok: true });
  assert.equal(parseEvalResult("true"), true);
  assert.equal(parseEvalResult("plain"), "plain");
});

test("composer fill carries a 300 KiB prompt only on stdin", { skip: process.platform === "win32" }, async (t) => {
  const fake = await fakeDriver(t);
  const prompt = 'quotes "\'\n中文 😀\n```js\nlet a = 1;\n```\t  '.repeat(9000);
  assert.ok(Buffer.byteLength(prompt) > 300 * 1024);
  const invocation = batchInvocation([["fill", "@e1", prompt]]);
  await fake.runner.run(invocation.args, { input: invocation.input });
  const [call] = await fake.calls();
  assert.ok(call.args.every((arg) => Buffer.byteLength(arg) <= 256));
  assert.deepEqual(JSON.parse(call.input), [["fill", "@e1", prompt]]);
});

// Execute the actual worker function without starting a job/browser. AST extraction is not a
// source pin: these tests observe insertion, digest refusal and the pre-send boundary.
async function workerFunction(name, context) {
  const source = await readFile(process.env.ORACLE_WORKER_TEST_SOURCE || new URL("./run-job.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("worker.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return vm.runInNewContext(`(${declaration.getText(tree)})`, context);
}

test("composer digest mismatch stops before send without retrying insertion", async () => {
  const prompt = 'résumé\n"quoted" 中文';
  for (const mismatch of [false, true]) {
    let evaluations = 0, insertions = 0, sends = 0;
    const digest = await composerTextDigest(prompt);
    const setComposerText = await workerFunction("setComposerText", {
      isGrokJob: () => false, toAsyncJsonScript: (s) => s,
      CHATGPT_COMPOSER_EDITOR_SELECTOR, AGENT_BROWSER_TIMEOUTS, batchInvocation, composerTextDigest, composerTextDigestExpression,
      evalPage: async () => ++evaluations === 1 ? true : { ...digest, sha256: mismatch ? "wrong" : digest.sha256 },
      snapshotText: async () => '- textbox "Chat with ChatGPT" [ref=e1]',
      findEntry: (snapshot, predicate) => parseSnapshotEntries(snapshot).find(predicate), isChatGptComposerEntry,
      withHeartbeatWhile: (fn) => fn(), log: async () => {},
      agentBrowser: async (_job, ...args) => {
        insertions += 1;
        assert.equal(args[0], "batch");
        assert.deepEqual(JSON.parse(args.at(-1).input), [["fill", "@e1", prompt]]);
      },
    });
    const submit = async () => { await setComposerText({}, prompt); sends += 1; };
    if (mismatch) await assert.rejects(submit(), /nothing was sent/); else await submit();
    assert.equal(insertions, 1);
    assert.equal(sends, mismatch ? 0 : 1);
  }
});


test("browser digest matches Node across canonical Unicode and rendered whitespace", async () => {
  const text = 're\u0301sume\u0301\n中文 😀\t"quotes"  ';
  const expression = composerTextDigestExpression("#editor");
  const actual = await vm.runInNewContext(expression, {
    document: { querySelectorAll: () => [{ isContentEditable: false, getClientRects: () => [1], innerText: "fallback" }, { isContentEditable: true, getClientRects: () => [1], innerText: text }] },
    crypto, TextEncoder,
  });
  const expected = await composerTextDigest('résumé 中文 😀 "quotes"');
  assert.equal(actual.length, expected.length);
  assert.equal(actual.sha256, expected.sha256);
  assert.notEqual((await composerTextDigest('résumé 中文 😁 "quotes"')).sha256, expected.sha256);
});


test("send activation timeout retains attempted state and never activates again", async () => {
  let state = "not_sent", clicks = 0;
  const clickSend = await workerFunction("clickSend", {
    waitForSendReady: async () => {}, sendAcceptanceState: async () => ({}),
    mutateJob: async (update) => { state = update({ promptSendState: state }).promptSendState; },
    activateSendButton: async () => { clicks += 1; throw new Error("agent-browser eval timed out"); },
  });
  await assert.rejects(clickSend({}, 0), /timed out/);
  assert.equal(state, "attempted");
  assert.equal(clicks, 1);
});
