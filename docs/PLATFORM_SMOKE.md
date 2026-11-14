# OMP Oracle platform smoke gate

This guide is for maintainers preparing and running the local Crabbox platform smoke gate for OMP Oracle (`omp-oracle`) across macOS and Ubuntu Linux before a release or after a platform-sensitive change.

Crabbox (`0.26.0` or newer) packs `omp-oracle`, the extension for Oh My Pi (OMP) and `pi`, and installs the tarball into clean `pi` target environments. Broken tarballs, missing target tools, and loader failures then fail locally, before you push or publish. To choose between the local gate and platform smoke, see [Which check to run](TEST_PLAN.md#which-check-to-run).

Companion docs: [Test plan](TEST_PLAN.md) · [Release](RELEASE.md) · [Compatibility](COMPATIBILITY.md)

## Source of truth and targets

The [platform smoke configuration (`platform-smoke.config.mjs`)](../platform-smoke.config.mjs) defines the targets, suites, Crabbox version floor, and Node validation major version for the runner:

- Config: [platform smoke configuration (`platform-smoke.config.mjs`)](../platform-smoke.config.mjs) (`requiredTargets`: `macos`, `ubuntu`; `requiredSuites`: `platform-build`, `real-extension`; `nodeValidationMajor`: `24`; `requiredCrabbox.minVersion`: `0.26.0`; `ubuntuContainerImage`: `omp-oracle-platform-smoke:node24`, built from `cimg/node:24.22`).
- CLI: [platform smoke CLI (`scripts/platform-smoke.mjs`)](../scripts/platform-smoke.mjs).
- Target runner: [target suite runner (`scripts/platform-smoke/targets.mjs`)](../scripts/platform-smoke/targets.mjs).
- Windows build script (carried from upstream): [Windows build script (`scripts/platform-smoke/platform-build-windows.ps1`)](../scripts/platform-smoke/platform-build-windows.ps1).
- Real runtime smoke: [real runtime smoke runner (`scripts/oracle-real-smoke.mjs`)](../scripts/oracle-real-smoke.mjs).
- Artifact root: `.artifacts/platform-smoke/` (gitignored).

As configured, `scripts/platform-smoke.mjs` accepts only the targets in `requiredTargets` (`macos` and `ubuntu`) and runs both `platform-build` and `real-extension` on each target.

Passing `--target windows-native` or running `npm run smoke:platform:windows-native` fails with `unsupported target: windows-native`, even though `--help` lists the target; see [Windows template maintenance](#windows-template-maintenance) for why the upstream Windows files stay in the tree and what changing `requiredTargets` entails.

## Required local setup

On a host with Node `24`+, Docker, `npm`, `git`, `tar`, and `rsync` (and `npm ci` already run in this checkout), install Crabbox `0.26.0` or newer with Homebrew and confirm `crabbox providers` lists `ssh` and `local-container`:

```bash
brew install openclaw/tap/crabbox
crabbox --version
crabbox providers
```

`PLATFORM_SMOKE_CRABBOX` overrides the Crabbox binary path across repositories; `PI_ORACLE_SMOKE_CRABBOX` is the project-specific alias and wins when both are set.

### Target prerequisites

Prepare both required target environments before running `npm run smoke:platform:doctor` or a target suite (Crabbox provisions an isolated target workspace, called a lease, per run, and `npm ci` supplies `pi` from `devDependencies`):

- `macos`: macOS Remote Login enabled, non-interactive `ssh $USER@localhost` working, and `node` (`24`+), `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` (`0.41.2`+) on the SSH `PATH`. Override the SSH host, user, or work root (`/Users/$USER/crabbox/omp-oracle` by default) with `PLATFORM_SMOKE_MAC_HOST`, `PLATFORM_SMOKE_MAC_USER`, or `PLATFORM_SMOKE_MAC_WORK_ROOT` (or their `PI_ORACLE_SMOKE_MAC_*` aliases, which win).
- `ubuntu`: Docker running locally and the configured container image (`PI_ORACLE_SMOKE_UBUNTU_IMAGE` or `PLATFORM_SMOKE_UBUNTU_IMAGE`, default `omp-oracle-platform-smoke:node24`) built with `node` (`24`+), `npm`, `git`, `tar`, `rsync`, `zstd`, and `agent-browser` (`0.41.2`+) on `PATH`. Build or refresh the local image from `scripts/platform-smoke/Dockerfile.ubuntu`:

```bash
docker build -t omp-oracle-platform-smoke:node24 -f scripts/platform-smoke/Dockerfile.ubuntu .
```

For the inactive Parallels `windows-native` prerequisites and `PLATFORM_SMOKE_WINDOWS_*` / `PI_ORACLE_SMOKE_WINDOWS_*` overrides carried from upstream, see [Windows template maintenance](#windows-template-maintenance).

### Real runtime suite auth and switches

`scripts/oracle-real-smoke.mjs` defaults to deterministic packed-install execution (`--mode packed`) and exposes these `PI_ORACLE_REAL_TEST_*` environment variables:

- Default mode requires no model API keys or provider browser sessions: it runs `/oracle-status` through the installed `pi` package loader.
- `PI_ORACLE_REAL_TEST_PROVIDER` and `PI_ORACLE_REAL_TEST_MODEL`: override the `pi` provider and model checked by `smoke:real:doctor` and used by optional model-agent debugging (defaults: `zai` and `glm-5.2`, `zai/glm-5.2`; `platform-smoke.config.mjs` maps provider API key variable names for `smoke:platform:doctor`).
- `PI_ORACLE_REAL_TEST_TIMEOUT_MS`: per-agent timeout in milliseconds (default `180000` ms).
- `PI_ORACLE_REAL_TEST_ARTIFACT_ROOT`: output directory for standalone `scripts/oracle-real-smoke.mjs` runs (default `.artifacts/real-smoke`).
- `PI_ORACLE_REAL_TEST_KEEP_TMP`: set `PI_ORACLE_REAL_TEST_KEEP_TMP=1` to preserve the temporary fixture directory after a standalone `scripts/oracle-real-smoke.mjs` run.
- `PI_ORACLE_REAL_TEST_MODEL_AGENT`: set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when debugging the slower model-agent path; `smoke:platform:doctor` then requires the provider API key variable (`ZAI_API_KEY` by default, printed only as present and redacted), while `scripts/oracle-real-smoke.mjs` writes a synthetic `.oracle-seed-generation` marker so no ChatGPT or Grok browser cookies are needed.
- `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK`: set `PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1` to enable the optional second-agent negative symlink check in standalone runs; `npm run sanity:oracle` covers archive exclusions and symlink-escape rejection by default.

## Commands

Choose when to run platform smoke from [Which check to run](TEST_PLAN.md#which-check-to-run). Run the doctor preflight before any target suite; `npm run smoke:platform:all` runs doctor automatically before `macos` and `ubuntu`:

```bash
# Doctor-first required matrix (macos + ubuntu, both suites)
npm run smoke:platform:all

# Preflight target setup and focused target/suite runs (<target>: macos or ubuntu; <suite>: platform-build or real-extension)
npm run smoke:platform:doctor
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
node scripts/platform-smoke.mjs run --target <target> --suite <suite>

# Cheap local invariant and platform-subset checks (no VM/container launch)
npm run check:platform-smoke
npm run sanity:oracle:platform
npm run verify:oracle:platform
```

`npm run smoke:platform:all` is the final stage of `npm run release:check` (and `prepublishOnly`); see [Release gate](RELEASE.md#release-gate).

## What `platform-build` proves

On each target (`macos` and `ubuntu`), `platform-build` runs these checks in order:

1. Checks the target Node major version against `nodeValidationMajor` (`24`).
2. Runs `npm ci`.
3. Verifies that `zstd` and `agent-browser` are on the target `PATH`.
4. Runs `npm run verify:oracle:platform` (`check:oracle-extension`, `check:platform-smoke`, `sanity:oracle:platform`, and `npm pack --dry-run`).
5. Packs the checkout with `npm pack`.
6. Copies `package.json`, `README.md`, `extensions/`, `prompts/`, and `docs/` into a fixture workspace and creates a fresh target-local `pi` project.
7. Runs `npm install --no-save <packed tarball>` inside that `pi` project.
8. Runs `PI_OFFLINE=1 pi install -l ./node_modules/omp-oracle --approve` so `pi` `0.79+` project-trust gating trusts the temporary fixture offline.
9. Runs `PI_OFFLINE=1 pi list --approve` and asserts that `omp-oracle` resolves from `node_modules/omp-oracle` without `pi -e` or `--extension` source shortcuts.

## What `real-extension` proves

`real-extension` is release-blocking packed-install runtime proof on each target. Its target command runs:

1. Runs `npm ci` when `node_modules` is absent on the Crabbox lease.
2. Runs `npm run smoke:real:doctor` to verify `pi`, `tar`, `zstd`, `agent-browser`, and (when `PI_ORACLE_REAL_TEST_MODEL_AGENT=1`) the provider API key variable.
3. Runs `npm run smoke:real:packed`, which packs this checkout with `npm pack`, installs the tarball into a clean `pi` project, runs `pi install -l ./node_modules/omp-oracle --approve`, verifies `pi list --approve`, executes `/oracle-status` through the installed `pi` loader (never source `pi -e`), and asserts that no job was created and the command never names `extensions/oracle/index.ts`.

The default suite needs no provider credentials and submits nothing. With `PI_ORACLE_REAL_TEST_MODEL_AGENT=1`, a model turn calls `oracle_submit` from the installed package instead, and the suite asserts whole-project archive creation and default exclusions.

For inner-loop debugging without packing, run `npm run smoke:real:source`, which loads `extensions/oracle/index.ts` via `pi --approve --no-extensions -e`; it is not release proof.

## Artifacts and secret scan

Each suite writes reviewable evidence under `.artifacts/platform-smoke/<run-id>/<target>/<suite>/`:

```text
summary.json              target.json               suite.json
command.txt               exit-code.txt             assertions.json
crabbox.stdout.txt        crabbox.stderr.txt        crabbox.timing.json
crabbox.stop.stdout.txt   crabbox.stop.stderr.txt   crabbox.stop.exit-code.txt
artifact-manifest.json
```

- `platform-build` also writes packed-install extracts: `packed-tarball.txt`, `packed-node-install.*`, `pi-install.*`, and `pi-list.*`.
- Conditional failure and transport files (each run starts a lease with `crabbox warmup` and releases it with `crabbox stop`): `failures.md` is written when an assertion fails; `redaction-violations.json` is written when secret scans match; `crabbox.warmup.stdout.txt` and `crabbox.warmup.stderr.txt` replace the execution stdout, stderr, and timing files if warmup fails; and a failed multi-suite stop writes `.artifacts/platform-smoke/<run-id>/<target>/lease-cleanup/`.
- Passing suites require `summary.ok === true`, `assertions.ok === true`, and `artifact-manifest.missing.length === 0`.

Artifacts are local evidence only; do not commit or share them without redaction. Built-in secret scans fail the suite if stdout, stderr, or text artifacts contain bearer tokens, authorization headers, session cookies, API keys, or safe-storage password values.

## Windows template maintenance

`scripts/platform-smoke/platform-build-windows.ps1`, the `smoke:platform:windows-native` script in `package.json`, and these Parallels template notes are carried from upstream `pi-oracle` (where Windows native support was validated at `pi-oracle` `0.7.20`; see [Platforms and runtime](COMPATIBILITY.md#platforms-and-runtime)).

Because this fork owns no Windows Parallels lane, `platform-smoke.config.mjs` sets `requiredTargets` to `["macos", "ubuntu"]`: `scripts/platform-smoke.mjs` rejects `--target windows-native` with `unsupported target: windows-native`, and `npm run smoke:platform:doctor` skips Windows checks.

Adding `"windows-native"` to `requiredTargets` is required for the runner and doctor to accept the target, and because `scripts/platform-smoke/invariants.mjs` requires `smoke:platform:all` to match `requiredTargets`, enabling it also makes `windows-native` release-blocking.

When enabled in `requiredTargets`, `windows-native` expects a stopped Parallels source VM `pi-extension-windows-template` (`PLATFORM_SMOKE_WINDOWS_VM` or `PI_ORACLE_SMOKE_WINDOWS_VM`) with the power-off snapshot `crabbox-ready` (`PLATFORM_SMOKE_WINDOWS_SNAPSHOT` or `PI_ORACLE_SMOKE_WINDOWS_SNAPSHOT`).

The SSH user comes from `PLATFORM_SMOKE_WINDOWS_USER` or `PI_ORACLE_SMOKE_WINDOWS_USER`, and the work root (`C:\crabbox\omp-oracle` by default) from `PLATFORM_SMOKE_WINDOWS_WORK_ROOT` or `PI_ORACLE_SMOKE_WINDOWS_NATIVE_WORK_ROOT`. The `PI_ORACLE_SMOKE_*` name wins when both are set.

The template requires OpenSSH, PowerShell, Git, Node (`24`+) and npm, `tar`, `zstd`, and `agent-browser` on `PATH`, and must never contain API keys, browser sessions, project checkouts, `.pi` state, artifacts, or secrets.

When the Windows target lacks a reusable tool such as `zstd` or `agent-browser`, update the shared `pi-extension-windows-template` VM rather than adding a per-run installer:

1. Revert or switch `pi-extension-windows-template` to the canonical `crabbox-ready` snapshot.
2. Boot the template VM.
3. Install or update the missing or outdated tool globally without baking in credentials or secrets.
4. Verify tool versions and ensure the automation browser is present from a fresh SSH session: `node --version`, `npm --version`, `git --version`, `tar --version`, `zstd --version`, `agent-browser --version`, and `agent-browser install`.
5. Remove downloads, caches, checkouts, `.pi`, `.artifacts`, `.debug`, browser auth and session state, and secrets.
6. Shut down Windows cleanly.
7. Create or promote the configured power-off `crabbox-ready` snapshot.
8. In a local configuration that adds `"windows-native"` to `requiredTargets` (and updates `smoke:platform:all` to match), run `npm run smoke:platform:doctor` and `npm run smoke:platform:windows-native` against the promoted snapshot.
9. Clean stale Crabbox clones and leases.
