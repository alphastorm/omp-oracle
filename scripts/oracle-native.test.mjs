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
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Oracle status must not access the network"); };
  t.after(async () => {
    globalThis.fetch = fetch;
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
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.deepEqual(loader.getPrompts().prompts.map((prompt) => prompt.name).sort(), ["oracle", "oracle-followup"]);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
  const errors = [];
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    await session.prompt("/oracle-status");
    const output = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
    assert.equal(output.length, 1, "native command dispatch must deliver exactly one status response");
    assert.match(JSON.stringify(output[0].content), /oracle|job/i);
    assert.deepEqual(await readdir(jobsDir), [], "status must not submit a browser job");
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
