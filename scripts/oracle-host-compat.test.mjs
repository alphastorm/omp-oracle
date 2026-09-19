import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// Exercise module linking against the API exported by older OMP, not the richer
// Pi devDependency. Missing trust APIs must neither crash startup nor grant trust.
test("OMP without Pi trust exports loads agent config and requires explicit project trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "oracle-host-compat-"));
  try {
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(projectDir, ".omp", "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "oracle.json"), JSON.stringify({ defaults: { preset: "instant" } }));
    await writeFile(join(projectDir, ".omp", "extensions", "oracle.json"), JSON.stringify({ defaults: { preset: "thinking_light" } }));
    const outfile = join(root, "config.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../extensions/oracle/lib/config.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [{
        name: "omp-host-api",
        setup(builder) {
          builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: "host", namespace: "omp-host" }));
          builder.onLoad({ filter: /.*/, namespace: "omp-host" }, () => ({
            contents: `export const CONFIG_DIR_NAME = ".omp"; export const getAgentDir = () => ${JSON.stringify(agentDir)};`,
            loader: "js",
          }));
        },
      }],
    });
    const { loadOracleConfig, getOracleConfigLoadDetails } = await import(pathToFileURL(outfile).href);
    assert.equal(loadOracleConfig(projectDir).defaults.preset, "instant");
    assert.equal(getOracleConfigLoadDetails(projectDir).projectConfigLoaded, false);
    assert.equal(loadOracleConfig(projectDir, { projectConfigTrusted: true }).defaults.preset, "thinking_light");
    assert.equal(loadOracleConfig(projectDir, { projectConfigTrusted: false }).defaults.preset, "instant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
