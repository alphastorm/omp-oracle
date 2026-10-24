import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CHATGPT_MODEL_PICKER_SELECTOR, matchesModelConfigurationOpener, mergeObservedSelection, parsePowerSliderDescription, POWER_SLIDER_TIER_LABELS, powerSliderClosedIntoSelection, powerSliderStepKey, powerSliderTargetLabel, snapshotCanSafelySkipModelConfiguration, snapshotHasPowerSliderMenu } from "../extensions/oracle/worker/chatgpt-ui-helpers.mjs";
import { parseSnapshotEntries } from "../extensions/oracle/worker/artifact-heuristics.mjs";
import { withLock } from "../extensions/oracle/worker/state-locks.mjs";

// Unlike the sanity harness, command dispatch and session lifecycle here are native Pi.
// Never call oracle_auth/oracle_submit: browser/provider qualification is a separate gate.
test("native Oracle status command dispatch creates no external job", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oracle-native-")));
  const agentDir = join(root, "agent");
  const jobsDir = join(root, "jobs");
  await mkdir(agentDir);
  await mkdir(jobsDir);
  const oldEnv = { ...process.env };
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
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

    await t.test("cross-project reads require the owning project and then return the saved answer", async () => {
      const owner = join(root, "external work root");
      await mkdir(owner);
      const at = new Date().toISOString();
      for (const [id, projectId] of [["local-fixture", root], ["external-fixture", owner]]) {
        const dir = join(jobsDir, `oracle-${id}`);
        await mkdir(dir);
        await writeFile(join(dir, "response.md"), `Saved answer for ${id}\n`);
        await writeFile(join(dir, "job.json"), JSON.stringify({
          id, projectId, cwd: projectId, sessionId: join(root, "origin.jsonl"),
          status: "complete", phase: "complete", createdAt: at, completedAt: at,
          responsePath: join(dir, "response.md"), artifactPaths: [],
          selection: { provider: "chatgpt", preset: "instant", modelFamily: "instant" },
        }));
      }
      const bridge = globalThis[Symbol.for("omp.pi-oracle.programmatic.v1")];
      const ctx = session.extensionRunner.createContext();
      const local = await bridge.read(ctx, { jobId: "local-fixture" });
      assert.equal(local.details.job.responsePreview, "Saved answer for local-fixture\n");
      const denied = await bridge.read(ctx, { jobId: "external-fixture" });
      assert.equal(denied.details.job, undefined, "discovery must not return another project's answer");
      assert.ok(denied.content[0].text.includes(`projectId: ${JSON.stringify(owner)}`),
        `cross-project error must name the owner and the projectId retry: ${denied.content[0].text}`);
      assert.equal(denied.details.error.code, "job_wrong_project");
      const accepted = await bridge.read(ctx, { jobId: "external-fixture", projectId: owner });
      assert.equal(accepted.details.job.responsePreview, "Saved answer for external-fixture\n",
        "explicit owning projectId must return the saved external answer");
      assert.equal(accepted.details.job.observedSelection, undefined, "legacy jobs need no UI observations");
      const wrong = await bridge.read(ctx, { jobId: "external-fixture", projectId: root });
      assert.equal(wrong.details.job, undefined, "an explicit but wrong project must not authorize the read");
      const missing = await bridge.read(ctx, { jobId: "missing-fixture", projectId: owner });
      assert.equal(missing.details.error.code, "job_not_found");
      const cancel = session.getToolDefinition("oracle_cancel");
      const refused = await cancel.execute("cancel-external", { jobId: "external-fixture" }, undefined, () => {}, ctx);
      assert.equal(refused.details.error.code, "job_not_found", "cancellation remains current-project only");
      await session.prompt("/oracle-status external-fixture");
      let messages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
      assert.ok(messages.at(-1).content.includes(`projectId: ${JSON.stringify(owner)}`));
      assert.doesNotMatch(messages.at(-1).content, /Saved answer/);
      await session.prompt(`/oracle-status external-fixture --projectId ${JSON.stringify(owner)}`);
      messages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
      assert.match(messages.at(-1).content, /job: external-fixture/);
      await session.prompt(`/oracle-read external-fixture --projectId ${JSON.stringify(owner)}`);
      messages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
      assert.match(messages.at(-1).content, /Saved answer for external-fixture/);
      await session.prompt(`/oracle-status --projectId ${JSON.stringify(owner)}`);
      messages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
      assert.match(messages.at(-1).content, /Recent jobs: external-fixture/);
      assert.equal(fetch.mock.callCount(), 0, "cross-project inspection must remain offline");
    });

    await t.test("worker slider observations survive failure, reopen a closed picker, and round-trip through native read/status", async (workerTest) => {
      // Like the capture proof, execute the production worker declarations without its main loop.
      // Browser replies are fixtures; mutation, locking, atomic files, and the loaded extension are real.
      const workerSource = await readFile(new URL("../extensions/oracle/worker/run-job.mjs", import.meta.url), "utf8");
      const tree = ts.createSourceFile("run-job.mjs", workerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const names = new Set(["secureWriteText", "readJobUnlocked", "writeJobUnlocked", "mutateJob",
        "recordObservedSelection", "configurePowerSlider", "readPowerSliderState", "focusPowerSlider",
        "observeSelection", "configureModel", "findLastEntry", "toJsonScript", "boundResearchFrame"]);
      const declarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
      assert.equal(declarations.length, names.size);
      const jobId = "external-fixture";
      const jobPath = join(jobsDir, `oracle-${jobId}`, "job.json");
      const initial = JSON.parse(await readFile(jobPath, "utf8"));
      let slider = "Medium, 2 of 5.";
      let pickerOpen = true;
      let focusable = false;
      let markerResolves = true;
      let snapshotOverride;
      let modelLabel = "Thinking effort Pro";
      let sliderReadError = false;
      let malformedSliderReply = false;
      let currentPickerMounted = true;
      let retainedPower = false;
      let closeAtTarget = false;
      // The open picker (2026-09-30) and the composer left behind by the 2026-10-18 failure.
      const openPicker = '- button "Select ChatGPT model" [expanded=true, ref=e118]\n- menuitem "Select model" [ref=e5]\n- menuitem "Power" [ref=e3]';
      const closedComposer = '- textbox "Ask ChatGPT" [ref=e136]: \n- button "Select ChatGPT model" [expanded=false, ref=e139]\n- button "Dictate" [ref=e140]';
      let closedSnapshot = closedComposer;
      const browserCalls = [];
      const automationCalls = [];
      const logs = [];
      const bindings = {
        jobId, jobPath, ORACLE_STATE_DIR: join(root, "state"), process,
        readFile, writeFile, chmod, rename, withLock, mergeObservedSelection,
        powerSliderTargetLabel, parsePowerSliderDescription, powerSliderStepKey, powerSliderClosedIntoSelection, snapshotCanSafelySkipModelConfiguration, snapshotHasPowerSliderMenu,
        matchesModelConfigurationOpener, parseSnapshotEntries,
        POWER_SLIDER_REOPEN_LIMIT: 2,
        POWER_SLIDER_ELEMENT: 'document.querySelector("[role=menuitem]")',
        CHATGPT_MODEL_PICKER_SELECTOR,
        CHATGPT_LABELS: { close: "Close" },
        isGrokJob: () => false,
        log: async (message) => logs.push(message),
        dismissBlockingDialog: async () => {},
        snapshotText: async () => snapshotOverride ?? (pickerOpen ? openPicker : closedSnapshot),
        openModelConfiguration: async () => { automationCalls.push("openModelConfiguration"); pickerOpen = true; return openPicker; },
        maybeClickLabeledEntry: async () => { automationCalls.push("close"); pickerOpen = false; return true; },
        waitForModelConfigurationToSettle: async () => { assert.equal(pickerOpen, false); },
        agentBrowser: async (_job, command, key) => {
          automationCalls.push([command, key]);
          if (command !== "press" || !pickerOpen) return;
          const stop = POWER_SLIDER_TIER_LABELS.indexOf(slider.split(",")[0]);
          // Live 2026-10-18: one ArrowLeft off Pro closed the picker with the composer on High.
          const leavingPro = stop === 4 && key === "ArrowLeft";
          const next = leavingPro ? 2 : stop + (key === "ArrowLeft" ? -1 : 1);
          pickerOpen = !leavingPro && !(closeAtTarget && next === 0);
          slider = `${POWER_SLIDER_TIER_LABELS[next]}, ${next + 1} of 5.`;
        },
        evalPage: async (_job, expression) => {
          browserCalls.push(expression);
          if (expression.includes("aria-describedby")) {
            if (sliderReadError) throw new Error("Fixture slider read failed");
            if (malformedSliderReply) return {};
          }
          if (expression.includes("power.focus")) return { focused: focusable && pickerOpen };
          if (expression.includes("aria-describedby") || expression.includes("createTreeWalker")) {
            // Execute the production DOM expression, including its actual selector and null handling.
            const document = {
              querySelector: (selector) => {
                if (selector === "[role=menuitem]") return pickerOpen || retainedPower
                  ? { getAttribute: () => "power-description" } : null;
                if (selector === CHATGPT_MODEL_PICKER_SELECTOR) return currentPickerMounted ? {} : null;
                throw new Error(`Unexpected selector: ${selector}`);
              },
              getElementById: () => ({ textContent: slider }),
              createTreeWalker: () => {
                let read = false;
                return { nextNode: () => {
                  if (read || !modelLabel) return null;
                  read = true;
                  return { textContent: modelLabel, parentElement: { closest: () => null } };
                } };
              },
            };
            return JSON.parse(new Function("document", "NodeFilter", `return ${expression}`)(document, { SHOW_TEXT: 4 }));
          }
          return { frames: [{ selector: "#research-frame", src: "https://fixture.web-sandbox.oaiusercontent.com/" }] };
        },
        captureExpression: () => "({})",
        deepResearchPageSession: "fixture-page",
        deepResearchCdp: {
          send: async (method) => {
            browserCalls.push(method);
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelector") return { nodeId: markerResolves ? 2 : 0 };
            if (method === "DOM.describeNode") return { node: { frameId: "fixture-frame", attributes: ["title", "Deep research"] } };
            throw new Error(`Unexpected DOM call: ${method}`);
          },
          frameSessions: () => [{ sessionId: "fixture-session", targetId: "fixture-frame" }],
          evaluate: async () => "https://fixture.web-sandbox.oaiusercontent.com/",
        },
      };
      const worker = new Function(...Object.keys(bindings),
        `let currentJob;\n${declarations.map((node) => node.getText(tree)).join("\n")}\nreturn {configurePowerSlider, configureModel, observeSelection, recordObservedSelection, boundResearchFrame};`)(...Object.values(bindings));
      const proJob = { ...initial, selection: { modelFamily: "pro" } };
      await assert.rejects(worker.configurePowerSlider(proJob), /Could not focus/);
      let saved = JSON.parse(await readFile(jobPath, "utf8"));
      assert.equal(saved.observedSelection.effortLabel, "Medium (2 of 5)",
        "a logged observation must survive failure before configureModel returns");
      assert.equal(saved.observedSelection.product, "thinking", "observed product must not be the requested Pro");
      assert.match(logs[0], /Medium \(2 of 5\); target Pro/);
      slider = "Pro, 5 of 5.";
      await worker.configurePowerSlider(proJob);
      await worker.recordObservedSelection(await worker.observeSelection(proJob));
      saved = JSON.parse(await readFile(jobPath, "utf8"));
      assert.equal(saved.observedSelection.product, "pro");
      assert.equal(saved.observedSelection.modelLabel, "Thinking effort Pro");
      assert.equal(saved.observedSelection.effortLabel, "Pro (5 of 5)");
      assert.equal(saved.responsePath, initial.responsePath, "partial observations preserve other durable job fields");
      const bridge = globalThis[Symbol.for("omp.pi-oracle.programmatic.v1")];
      const result = await bridge.read(session.extensionRunner.createContext(), { jobId, projectId: initial.projectId });
      assert.deepEqual(result.details.job.observedSelection, saved.observedSelection);
      assert.match(result.content[0].text, /observed-product: pro/);
      // The closed pill names no stop, so the worker reopens the picker and resumes from the slider.
      focusable = true;
      await worker.configurePowerSlider({ ...initial, selection: { modelFamily: "instant" } });
      assert.equal(slider, "Instant, 1 of 5.");
      saved = JSON.parse(await readFile(jobPath, "utf8"));
      assert.equal(saved.observedSelection.effortLabel, "Instant (1 of 5)");

      workerTest.beforeEach(() => {
        snapshotOverride = undefined;
        sliderReadError = false;
        malformedSliderReply = false;
        currentPickerMounted = true;
        retainedPower = false;
        closeAtTarget = false;
        closedSnapshot = closedComposer;
        modelLabel = "Thinking effort Pro";
      });

      await workerTest.test("already-configured submissions freshly read the current slider without reconfiguring", async () => {
        const selection = { modelFamily: "thinking", effort: "standard", autoSwitchToThinking: false };
        const configuredJob = { ...initial, selection };
        snapshotOverride = '- button "Thinking, click to remove" [ref=e110]\n- button "Thinking" [expanded=false, ref=e111]\n' + openPicker;
        modelLabel = "Thinking effort Medium";
        pickerOpen = true;
        const beforeAutomation = automationCalls.length;
        for (const [description, expected] of [
          ["Medium, 2 of 5.", "Medium (2 of 5)"],
          ["Medium, 3 of 6.", "Medium (3 of 6)"],
        ]) {
          saved = JSON.parse(await readFile(jobPath, "utf8"));
          saved.observedSelection = { at: "2000-01-01T00:00:00.000Z", effortLabel: "Pro (5 of 5)" };
          await writeFile(jobPath, JSON.stringify(saved));
          slider = description;
          const beforeReads = browserCalls.length;
          const observedAfter = Date.now();
          await worker.configureModel(configuredJob);
          assert.match(logs.at(-1), /already appears configured.*skipping reconfiguration/);
          await worker.recordObservedSelection(await worker.observeSelection(configuredJob));
          saved = JSON.parse(await readFile(jobPath, "utf8"));
          assert.equal(saved.observedSelection.effortLabel, expected,
            "a skipped configuration must replace stale effort evidence with this submission's slider reading");
          assert.equal(saved.observedSelection.modelLabel, modelLabel);
          assert.ok(Date.parse(saved.observedSelection.at) >= observedAfter, "observation timestamp must come from this read");
          assert.equal(saved.observedSelection.effortControls, undefined);
          assert.equal(slider, description, "observing the slider must not change its selection");
          const reads = browserCalls.slice(beforeReads);
          assert.equal(reads.filter((expression) => expression.includes("aria-describedby")).length, 1);
          assert.ok(reads.every((expression) => !/\.(?:focus|click)\(/.test(expression)), "observation must be read-only");
          assert.equal(saved.responsePath, initial.responsePath);
          const observed = await bridge.read(session.extensionRunner.createContext(), { jobId, projectId: initial.projectId });
          assert.deepEqual(observed.details.job.observedSelection, saved.observedSelection);
        }
        assert.equal(automationCalls.length, beforeAutomation, "configured submissions must not reopen a menu or send keys");
        snapshotOverride = undefined;
      });

      await workerTest.test("a configured compact picker reports its actual label without a current-shell DOM node", async () => {
        currentPickerMounted = false;
        pickerOpen = false;
        snapshotOverride = '- button "Thinking, click to remove" [ref=e110]\n- button "Thinking" [expanded=false, ref=e111]';
        const configuredJob = { ...initial, selection: { modelFamily: "thinking", effort: "standard" } };
        const beforeAutomation = automationCalls.length;
        await worker.configureModel(configuredJob);
        await worker.recordObservedSelection(await worker.observeSelection(configuredJob));
        saved = JSON.parse(await readFile(jobPath, "utf8"));
        assert.equal(saved.observedSelection.modelLabel, "Thinking");
        assert.equal(saved.observedSelection.effortLabel, null);
        assert.equal(automationCalls.length, beforeAutomation);
        snapshotOverride = undefined;
        currentPickerMounted = true;
      });

      await workerTest.test("absent or unreadable effort controls replace stale evidence without changing submission behavior", async () => {
        const beforeAutomation = automationCalls.length;
        for (const fixture of [
          { open: false, expected: "absent" },
          { open: true, error: true, expected: "unavailable" },
          { open: true, description: "Use arrow keys to adjust power.", expected: "unavailable" },
          { open: true, description: "Pro, 6 of 5.", expected: "unavailable" },
          { open: true, malformed: true, expected: "unavailable" },
        ]) {
          saved = JSON.parse(await readFile(jobPath, "utf8"));
          saved.observedSelection = { at: "2000-01-01T00:00:00.000Z", modelLabel: "Thinking effort Pro", product: "pro", effortLabel: "Pro (5 of 5)" };
          await writeFile(jobPath, JSON.stringify(saved));
          pickerOpen = fixture.open;
          sliderReadError = fixture.error;
          malformedSliderReply = fixture.malformed;
          slider = fixture.description ?? "Pro, 5 of 5.";
          modelLabel = "";
          const observedAfter = Date.now();
          await worker.recordObservedSelection(await worker.observeSelection(proJob));
          saved = JSON.parse(await readFile(jobPath, "utf8"));
          assert.equal(saved.observedSelection.effortLabel, null);
          assert.equal(saved.observedSelection.effortControls, fixture.expected);
          assert.equal(saved.observedSelection.modelLabel, undefined);
          assert.equal(saved.observedSelection.product, undefined);
          assert.ok(Date.parse(saved.observedSelection.at) >= observedAfter);
        }
        assert.equal(automationCalls.length, beforeAutomation);
        sliderReadError = false;
        malformedSliderReply = false;
        modelLabel = "Thinking effort Pro";
      });

      await workerTest.test("a collapsed picker cannot refresh provenance from its retained Power node", async () => {
        pickerOpen = false;
        retainedPower = true;
        slider = "Pro, 5 of 5.";
        snapshotOverride = closedComposer + '\n- menuitem "Power" [ref=e3]';
        const beforeAutomation = automationCalls.length;
        const observation = await worker.observeSelection(proJob);
        assert.equal(observation.effortLabel, null);
        assert.equal(observation.effortControls, "absent");
        assert.equal(automationCalls.length, beforeAutomation);
        retainedPower = false;
        snapshotOverride = undefined;
      });

      await workerTest.test("submission-time absence intentionally replaces the configuration-time slider reading", async () => {
        pickerOpen = false;
        slider = "Pro, 5 of 5.";
        await worker.configureModel(proJob);
        saved = JSON.parse(await readFile(jobPath, "utf8"));
        assert.equal(saved.observedSelection.effortLabel, "Pro (5 of 5)");
        await worker.recordObservedSelection(await worker.observeSelection(proJob));
        saved = JSON.parse(await readFile(jobPath, "utf8"));
        assert.equal(saved.observedSelection.effortLabel, null);
        assert.equal(saved.observedSelection.effortControls, "absent");
        // Also exercise the existing branch where stepping closes the picker on the target.
        pickerOpen = true;
        slider = "Medium, 2 of 5.";
        closeAtTarget = true;
        closedSnapshot = '- button "Instant" [expanded=false, ref=e111]';
        await worker.configurePowerSlider({ ...initial, selection: { modelFamily: "instant" } });
        saved = JSON.parse(await readFile(jobPath, "utf8"));
        assert.equal(saved.observedSelection.effortLabel, "Instant");
        await worker.recordObservedSelection(await worker.observeSelection(proJob));
        saved = JSON.parse(await readFile(jobPath, "utf8"));
        assert.equal(saved.observedSelection.effortLabel, null, "do not relabel configuration-time evidence as a current offered set");
        closeAtTarget = false;
        closedSnapshot = closedComposer;
      });

      // Research observes its own product and explicit absence, not an old model's slider evidence.
      saved.observedSelection = { at: "2000-01-01T00:00:00.000Z", modelLabel: "Thinking effort Pro", product: "pro", effortLabel: "Pro (5 of 5)" };
      await writeFile(jobPath, JSON.stringify(saved));
      const before = browserCalls.length;
      await worker.recordObservedSelection(await worker.observeSelection({ selection: { tool: "deep_research" } }, { deepResearchVerified: true }));
      assert.equal(browserCalls.length, before, "a research tool must not query the irrelevant model picker");
      await worker.boundResearchFrame({}, { responseIndex: 0 });
      saved = JSON.parse(await readFile(jobPath, "utf8"));
      assert.equal(saved.observedSelection.product, "deep_research");
      assert.equal(saved.observedSelection.deepResearchIframeTitle, "Deep research");
      assert.equal(saved.observedSelection.modelLabel, undefined);
      assert.equal(saved.observedSelection.effortLabel, null);
      assert.equal(saved.observedSelection.effortControls, "absent");
      assert.ok(Number.isFinite(Date.parse(saved.observedSelection.at)));
      assert.deepEqual(browserCalls.slice(before + 1), ["DOM.getDocument", "DOM.querySelector", "DOM.describeNode"],
        "iframe provenance reuses exactly the existing frame-binding DOM calls");
      await session.prompt(`/oracle-status ${jobId} --projectId ${JSON.stringify(initial.projectId)}`);
      const messages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "oracle-command-output");
      assert.match(messages.at(-1).content, /observed-product: deep_research/);
      assert.match(messages.at(-1).content, /deep-research-iframe-title: Deep research/);
      const research = await bridge.read(session.extensionRunner.createContext(), { jobId, projectId: initial.projectId });
      assert.deepEqual(research.details.job.observedSelection, saved.observedSelection);
      assert.equal(fetch.mock.callCount(), 0);
      // A re-rendered frame loses its capture marker before DOM.querySelector; its src still binds it.
      markerResolves = false;
      assert.equal((await worker.boundResearchFrame({}, { responseIndex: 0 })).targetId, "fixture-frame");
    });
  } finally {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
});
