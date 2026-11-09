import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = await mkdtemp(join(tmpdir(), "oracle-host-core-"));
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = join(root, "agent");
const fakeBinary = join(root, "agent-browser");
const driverLog = join(root, "driver.jsonl");
const driverState = join(root, "driver-state.json");
let driverRevision = 0;
process.env.PI_ORACLE_STATE_DIR = join(root, "state");
process.env.PI_ORACLE_JOBS_DIR = join(root, "jobs");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.AGENT_BROWSER_PATH = fakeBinary;
process.env.AGENT_BROWSER_SOCKET_DIR = join(root, "driver-sockets");
await Promise.all([
  mkdir(process.env.PI_ORACLE_STATE_DIR, { mode: 0o700 }),
  mkdir(process.env.PI_ORACLE_JOBS_DIR, { mode: 0o700 }),
  mkdir(process.env.AGENT_BROWSER_SOCKET_DIR, { mode: 0o700 }),
  mkdir(join(agentDir, "extensions"), { recursive: true, mode: 0o700 }),
]);
async function writeDriver(version: string, listed: string[] = []): Promise<void> {
  await writeFile(driverLog, "");
  await writeFile(driverState, JSON.stringify(listed));
  await writeFile(fakeBinary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(driverLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") console.log(${JSON.stringify(version)});
else if (args.join(" ") === "session list") console.log(JSON.parse(fs.readFileSync(${JSON.stringify(driverState)}, "utf8")).join("\\n"));
else if (args.at(-1) === "close") fs.writeFileSync(${JSON.stringify(driverState)}, "[]");
else process.exitCode = 2;
`);
  await chmod(fakeBinary, 0o755);
  const modified = new Date(Date.now() + ++driverRevision * 2_000);
  await utimes(fakeBinary, modified, modified);
}
async function driverCommands(): Promise<string[][]> {
  return (await readFile(driverLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
await writeDriver("agent-browser 0.41.2");
const { loadOracleConfig } = await import("../extensions/oracle/lib/config.js");
const { assertOracleSubmitPrerequisites, cleanupRuntimeArtifacts } = await import("../extensions/oracle/lib/runtime.js");
const { classifyOracleReadinessError } = await import("../extensions/oracle/lib/tools.js");
const { default: oracleExtension } = await import("../extensions/oracle/index.js");
const { createPiHarness, createExtensionCtx, createPersistedSessionManager } = await import("./oracle-sanity-support.js");
const config = loadOracleConfig(root, { projectConfigTrusted: false });
config.browser.executablePath = process.execPath;
config.browser.cloneStrategy = "copy";
await mkdir(config.browser.authSeedProfileDir, { recursive: true, mode: 0o700 });
await writeFile(join(config.browser.authSeedProfileDir, ".oracle-seed-generation"), "test-seed\n");
after(() => rm(root, { recursive: true, force: true }));

test("npm pack excludes tests and retains the extension and worker", async (t) => {
  const { stdout } = await promisify(execFile)(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    shell: process.platform === "win32",
    maxBuffer: 4 * 1024 * 1024,
  });
  const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = pack.files.map((file) => file.path);
  assert.deepEqual(paths.filter((path) => /\.test\.(mjs|ts)$/.test(path)), []);
  assert.ok(paths.includes("extensions/oracle/index.ts"));
  assert.ok(paths.includes("extensions/oracle/worker/run-job.mjs"));
  t.diagnostic(`npm pack file count: ${paths.length}`);
});

test("preflight rejects unsupported or unknown driver versions and caches each binary verdict", { skip: process.platform === "win32" }, async () => {
  for (const version of ["agent-browser 0.39.1", "garbage"]) {
    await writeDriver(version);
    for (let tick = 0; tick < 3; tick++) {
      await assert.rejects(() => assertOracleSubmitPrerequisites(config, "grok"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, version === "garbage" ? /could not be determined/ : /too old: found 0\.39\.1/);
        assert.match(error.message, /0\.41\.2 or newer/);
        const readiness = classifyOracleReadinessError(error);
        assert.equal(readiness.readiness, classifyOracleReadinessError(new Error("Oracle prerequisite not found on PATH: agent-browser. Install agent-browser and retry.")).readiness);
        assert.equal(readiness.message, error.message);
        return true;
      });
    }
    assert.deepEqual(await driverCommands(), [["--version"]]);
  }
  for (const version of ["agent-browser 0.41.2", "0.42.0-beta.1"]) {
    await writeDriver(version);
    await Promise.all(Array.from({ length: 3 }, () => assertOracleSubmitPrerequisites(config, "grok")));
    await assertOracleSubmitPrerequisites(config, "grok");
    assert.deepEqual(await driverCommands(), [["--version"]]);
  }
});

test("the shared version gate accepts supported releases and rejects old or unreadable versions", { skip: process.platform === "win32" }, async () => {
  const { assertAgentBrowserVersionSupported } = await import("../extensions/oracle/shared/agent-browser-version.mjs");
  for (const [output, expected] of [
    ["agent-browser 0.39.1", /too old: found 0\.39\.1.*need 0\.41\.2 or newer/],
    ["agent-browser 0.40.0", /too old: found 0\.40\.0/],
    ["agent-browser 0.41.1", /too old: found 0\.41\.1/],
    ["garbage", /version could not be determined/],
    ["agent-browser 0.41.2", "0.41.2"],
    ["0.42.0-beta.1", "0.42.0"],
    ["agent-browser 1.0.0", "1.0.0"],
  ] as const) {
    await writeDriver(output);
    if (typeof expected === "string") assert.equal(await assertAgentBrowserVersionSupported(fakeBinary), expected);
    else await assert.rejects(() => assertAgentBrowserVersionSupported(fakeBinary), expected);
  }
});

test("config rejects driver-invalid session prefixes while retaining Unicode letters and digits", async () => {
  const configPath = join(agentDir, "extensions", "oracle.json");
  try {
    for (const prefix of ["oracle.dev", "oracle/name", "oracle name", "", 42]) {
      await writeFile(configPath, JSON.stringify({ browser: { sessionPrefix: prefix } }));
      assert.throws(() => loadOracleConfig(root, { projectConfigTrusted: false }), /browser\.sessionPrefix must contain only letters, digits, '-' and '_'/);
    }
    for (const prefix of ["oracle_dev-2", "оракул", "神託２"]) {
      await writeFile(configPath, JSON.stringify({ browser: { sessionPrefix: prefix } }));
      assert.equal(loadOracleConfig(root, { projectConfigTrusted: false }).browser.sessionPrefix, prefix);
    }
  } finally {
    await rm(configPath, { force: true });
  }
});

test("runtime cleanup closes listed sessions only", { skip: process.platform === "win32" }, async () => {
  for (const listed of [[], ["oracle-x"]]) {
    await writeDriver("agent-browser 0.41.2", listed);
    const report = await cleanupRuntimeArtifacts({ runtimeSessionName: "oracle-x" });
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(await driverCommands(), listed.length
      ? [["session", "list"], ["--session", "oracle-x", "close"], ["session", "list"]]
      : [["session", "list"]]);
  }
});

test("interactive oracle input consumes rejected and throwing host submissions without unhandled rejections", async (t) => {
  for (const variant of ["throw", "reject", "void", "stale-ui"] as const) {
    await t.test(variant, async () => {
      const harness = createPiHarness();
      const manager = createPersistedSessionManager(`host-input-${variant}`);
      const ctx = createExtensionCtx(manager, undefined, root);
      const unhandled: unknown[] = [];
      const recordUnhandled = (error: unknown) => { unhandled.push(error); };
      process.on("unhandledRejection", recordUnhandled);
      let calls = 0;
      harness.sendUserMessage = () => {
        calls++;
        if (variant === "void") return;
        const error = Object.assign(new Error("Prompt dropped"), { name: "PromptDroppedError" });
        if (variant === "throw") throw error;
        if (variant === "stale-ui") {
          ctx.ui.notify = () => { throw new Error("Context is stale"); };
        }
        return Promise.reject(error);
      };
      try {
        oracleExtension(harness);
        const input = harness.handlers.get("input");
        assert.ok(input);
        assert.deepEqual(await input({ text: "/oracle review", source: "interactive" }, ctx), { action: "handled", handled: true });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, 1);
        assert.deepEqual(unhandled, []);
        const warnings = ctx.ui.notifications.filter((entry) => entry.level === "warning");
        if (variant === "void" || variant === "stale-ui") assert.deepEqual(warnings, []);
        else assert.equal(warnings[0]?.message, "Oracle request was not submitted by the host: Prompt dropped. Re-enter /oracle when the agent can accept it.");
      } finally {
        process.off("unhandledRejection", recordUnhandled);
        const sessionFile = manager.getSessionFile();
        if (sessionFile) await rm(dirname(sessionFile), { recursive: true, force: true });
      }
    });
  }
});
