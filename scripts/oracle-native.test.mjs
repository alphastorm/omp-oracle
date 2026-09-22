import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Unlike the sanity harness, command dispatch and session lifecycle here are native Pi.
// Never call oracle_auth/oracle_submit: browser/provider qualification is a separate gate.
test("native Oracle status command dispatch creates no external job", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-native-"));
  const agentDir = join(root, "agent");
  const jobsDir = join(root, "jobs");
  await mkdir(agentDir);
  await mkdir(jobsDir);
  const oldEnv = { ...process.env };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
    PI_ORACLE_JOBS_DIR: jobsDir, PI_ORACLE_STATE_DIR: join(root, "state") });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Oracle status must not access the network"); });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.create(root, join(root, "sessions")), noTools: "builtin" });
  const errors = [];
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    await session.prompt("/oracle-status");
    const output = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
    assert.equal(output.length, 1, "native command dispatch must deliver exactly one status response");
    assert.equal(output[0].display, true, "status response must be visible to the user");
    assert.equal(output[0].details.level, "info", "an empty project must report status successfully");
    assert.equal(fetch.mock.callCount(), 0, "status must not attempt network access, even if a caller catches the failure");
    assert.deepEqual(await readdir(jobsDir), [], "status must not submit a browser job");
    assert.deepEqual(errors, []);
  } finally {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
});
