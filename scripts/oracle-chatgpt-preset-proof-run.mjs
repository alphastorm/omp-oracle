#!/usr/bin/env node
// Purpose: Submit the live ChatGPT preset proof (docs/RELEASE.md) through isolated loaded-extension OMP sessions.
// Responsibilities: One marker-prompt job per canonical preset, sequentially, from an isolated agent/jobs/state root;
//   wait for completion; write .artifacts/chatgpt-preset-proof/latest.json; run the release checker on it.
// Scope: Maintainer release tooling. Consumes the maintainer's ChatGPT account through the existing-Chrome relay.
// Usage: PI_ORACLE_PROOF_MODEL=<omp model id> PI_ORACLE_PROOF_MODELS_YML=<models.yml> npm run release:proof:chatgpt-presets:run [-- preset ...]
// Invariants/Assumptions: The canonical preset list and the proof contract belong to scripts/oracle-chatgpt-preset-proof.mjs;
//   this runner only produces jobs and the proof file that checker validates. Every job runs from the current checkout's
//   extension source (`--no-extensions -e`), never from an installed package.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CHECKER = resolve(SCRIPT_DIR, "oracle-chatgpt-preset-proof.mjs");
const PROOF_PATH = resolve(REPO_ROOT, ".artifacts/chatgpt-preset-proof/latest.json");
const ROOT = process.env.PI_ORACLE_PROOF_ROOT?.trim() || "/tmp/omp-oracle-proof";
const CLI = process.env.PI_ORACLE_PROOF_CLI?.trim() || "omp";
const MODEL = process.env.PI_ORACLE_PROOF_MODEL?.trim();
const MODELS_YML = process.env.PI_ORACLE_PROOF_MODELS_YML?.trim();
const RELAY = process.env.PI_ORACLE_PROOF_RELAY?.trim() || "http://127.0.0.1:9224";
const JOB_TIMEOUT_MS = 40 * 60_000;
const SESSION_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(message) {
  console.error(`${message}

Usage: PI_ORACLE_PROOF_MODEL=<omp model id> PI_ORACLE_PROOF_MODELS_YML=<models.yml> node scripts/oracle-chatgpt-preset-proof-run.mjs [preset ...]

Environment:
  PI_ORACLE_PROOF_MODEL       model id the isolated OMP session uses to call oracle_submit (required)
  PI_ORACLE_PROOF_MODELS_YML  models.yml copied into the isolated agent dir so that model resolves (required)
  PI_ORACLE_PROOF_RELAY       existing-Chrome relay endpoint (default ${RELAY})
  PI_ORACLE_PROOF_ROOT        isolated agent/sessions/jobs/state root (default ${ROOT})
  PI_ORACLE_PROOF_CLI         OMP executable (default ${CLI})`);
  process.exit(2);
}

// Print-mode OMP waits for piped stdin forever, so stdin is closed explicitly.
function runSession(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(CLI, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), SESSION_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${CLI} exited with code ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function jobDirs(jobsDir) {
  return new Set(readdirSync(jobsDir).filter((name) => name.startsWith("oracle-")));
}

async function main() {
  if (!MODEL) usage("PI_ORACLE_PROOF_MODEL is required.");
  if (!MODELS_YML || !existsSync(MODELS_YML)) usage("PI_ORACLE_PROOF_MODELS_YML must point at an existing models.yml.");
  const template = JSON.parse(execFileSync(process.execPath, [CHECKER, "template"], { cwd: REPO_ROOT, encoding: "utf8" }));
  const canonical = Object.keys(template.jobs);
  const selected = process.argv.slice(2).length ? process.argv.slice(2) : canonical;
  for (const preset of selected) {
    if (!canonical.includes(preset)) usage(`Unknown or excluded preset: ${preset}. Canonical live presets: ${canonical.join(", ")}`);
  }

  const agentDir = join(ROOT, "agent");
  const jobsDir = join(ROOT, "jobs");
  for (const dir of [join(agentDir, "extensions"), join(ROOT, "sessions"), jobsDir, join(ROOT, "state")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(MODELS_YML, join(agentDir, "models.yml"));
  writeFileSync(join(agentDir, "extensions", "oracle.json"), `${JSON.stringify({ browser: { chatGptRelayEndpoint: RELAY } })}\n`, { mode: 0o600 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_ORACLE_JOBS_DIR: jobsDir, PI_ORACLE_STATE_DIR: join(ROOT, "state"), PI_TELEMETRY: "0" };

  const outcomes = [];
  const seen = jobDirs(jobsDir);
  for (const preset of selected) {
    const marker = `PRESET ${preset} OK`;
    const prompt = `Call the oracle_submit tool exactly once with these exact parameters and do not change any of them: prompt = "Reply with exactly two lines and nothing else. Line 1: ${marker}. Line 2: PACKAGE omp-oracle", files = ["README.md"], preset = "${preset}". Do not use bash. After the tool returns, reply with only the job id.`;
    const startedAt = Date.now();
    const output = await runSession([
      "--standard", "--cwd", REPO_ROOT, "-p", "--auto-approve", "--session-dir", join(ROOT, "sessions"),
      "--model", MODEL, "--thinking", "low", "--no-extensions", "-e", resolve(REPO_ROOT, "extensions/oracle/index.ts"), prompt,
    ], env);
    const created = [...jobDirs(jobsDir)].filter((name) => !seen.has(name));
    const reported = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    const jobDirName = created.find((name) => name === `oracle-${reported}`) || (created.length === 1 ? created[0] : undefined);
    if (!jobDirName) {
      outcomes.push({ preset, error: "no job created", output: output.trim().slice(-400) });
      console.log(JSON.stringify(outcomes.at(-1)));
      continue;
    }
    seen.add(jobDirName);
    const jobDir = join(jobsDir, jobDirName);
    let job;
    for (;;) {
      job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
      if (["complete", "failed", "cancelled"].includes(job.status) || Date.now() - startedAt > JOB_TIMEOUT_MS) break;
      await sleep(5000);
    }
    const response = existsSync(join(jobDir, "response.md")) ? readFileSync(join(jobDir, "response.md"), "utf8") : "";
    outcomes.push({
      preset, jobId: jobDirName.slice("oracle-".length), jobDir, status: job.status, selectedPreset: job.selection?.preset,
      responseOk: response.includes(marker) && response.includes("PACKAGE omp-oracle"), conversation: job.chatUrl, ms: Date.now() - startedAt, error: job.error,
    });
    console.log(JSON.stringify(outcomes.at(-1)));
  }
  writeFileSync(join(jobsDir, `outcomes-${template.packageVersion}.json`), `${JSON.stringify(outcomes, null, 2)}\n`, { mode: 0o600 });

  const usable = outcomes.filter((outcome) => outcome.status === "complete" && outcome.responseOk);
  if (usable.length !== selected.length) {
    console.error(`Only ${usable.length}/${selected.length} presets completed with both markers; the proof file was not written.`);
    process.exit(1);
  }
  const previous = existsSync(PROOF_PATH) ? JSON.parse(readFileSync(PROOF_PATH, "utf8")) : undefined;
  const jobs = { ...(selected.length === canonical.length ? {} : previous?.jobs || {}) };
  for (const outcome of usable) {
    jobs[outcome.preset] = { preset: outcome.preset, provider: "chatgpt", jobId: outcome.jobId, jobDir: outcome.jobDir, conversation: outcome.conversation };
  }
  mkdirSync(dirname(PROOF_PATH), { recursive: true });
  writeFileSync(PROOF_PATH, `${JSON.stringify({ ...template, jobs, validatedAt: new Date().toISOString() }, null, 2)}\n`);
  execFileSync(process.execPath, [CHECKER, "check"], { cwd: REPO_ROOT, stdio: "inherit", env: { ...process.env, PI_ORACLE_JOBS_DIR: jobsDir } });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
