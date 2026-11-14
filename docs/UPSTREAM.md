# Upstream

This page is for maintainers of OMP Oracle, the Oh My Pi (OMP) fork of [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle) published on npm as `omp-oracle`, recording what the fork preserves from upstream, what it changes, and how to sync upstream commits.

Companion docs: [Documentation](README.md) · [Architecture](ARCHITECTURE.md) · [Compatibility](COMPATIBILITY.md) · [Test plan](TEST_PLAN.md) · [Platform smoke](PLATFORM_SMOKE.md) · [Release](RELEASE.md) · [Changelog](../CHANGELOG.md).

## What is preserved

The fork keeps upstream history, everyday user and agent entry points, on-disk state paths, and authorship intact:

- **Git history.** The fork branched from upstream `main` at the `upstream-compat-20260918` merge and retains every upstream commit.
- **User and agent contracts.** `/oracle`, `/oracle-followup`, `/oracle-auth`, `/oracle-read`, `/oracle-status`, `/oracle-cancel`, and `/oracle-clean`; `oracle_preflight`, `oracle_auth`, `oracle_submit`, `oracle_read`, and `oracle_cancel`; and the `/oracle` and `/oracle-followup` prompt templates.
- **Runtime and state identifiers.** The job directory layout under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, the `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, and the `pi-oracle-auth-*` diagnostics directories under the system temporary directory, so existing configurations and saved jobs keep working across the package rename.
- **Validation harness.** `npm run verify:oracle`, `npm run sanity:oracle` in [Test plan](TEST_PLAN.md#what-each-check-covers), the [Crabbox suites](PLATFORM_SMOKE.md), and `npm run release:proof:chatgpt-presets` in [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof).
- **License and authorship.** MIT license; Mitch Fultz is credited as a contributor in `package.json` and `README.md`.

## What the fork changes

OMP Oracle extends upstream with opt-in shared-Chrome transports, Oh My Pi host and programmatic entry points, collection and driver hardening, and fork-owned release automation:

- **Package identity.** Published on npm as `omp-oracle` from `alphastorm/omp-oracle`; upstream's `pi-oracle` package remains separate and cannot stay installed alongside `omp-oracle`.
- **Opt-in shared-Chrome transports for ChatGPT.** Adds the [existing-Chrome relay](ARCHITECTURE.md#existing-chrome-relay-transport) via `browser.chatGptRelayEndpoint` and the [managed browser](ARCHITECTURE.md#managed-browser-transport) via `browser.chatGptManagedProfileDir`, pinning commands to one job-owned tab without `Page.bringToFront` or `chrome://downloads` scraping, plus CDP frame capture and native Markdown export for `deep_research` ([Design lineage](ARCHITECTURE.md#design-lineage)).
- **Oh My Pi host compatibility.** Node worker launch, project-trust probing via `ctx.isProjectTrusted?.() ?? true` and standalone config compatibility on hosts without Pi's trust exports, dual interactive input consumption (`handled: true` and `action: "handled"`), rejected `sendUserMessage` handling, and tolerating transient `/backend-api/me` `403` probes when the ChatGPT composer is usable.
- **Programmatic bridge and `/oracle-run`.** Registers the `omp.pi-oracle.programmatic.v1` symbol on `globalThis` and `/oracle-run <preflight|submit|read> <request.json> <result.json> [<marker.json>]` (`extensions/oracle/lib/run-command.ts`) for host-side tool execution without a model turn.
- **Cross-project job inspection.** Adds optional `projectId` on `oracle_read` and `--projectId` on `/oracle-status` and `/oracle-read` so jobs under the shared jobs root can be read across projects only when the owning project root is named explicitly.
- **Job observability fields.** Records `promptSendState` (`not_sent`, `attempted`, `accepted`), stable worker `errorCode` values, `observedSelection` for product, model, effort, and Deep Research provenance, and `observedTurn` duration metadata in `job.json` and read outputs.
- **ChatGPT UI and collection hardening.** Shared UI control vocabulary in `extensions/oracle/worker/chatgpt-ui-helpers.mjs`, keyboard-driven thinking-effort slider stepping with reopen recovery, stale-stop and one-per-job missing-turn reload recovery, bound-turn capture with transport-URL redaction in `extensions/oracle/worker/response-capture.mjs`, and non-sending recollection (`oracle_read` with `action: "recollect"`).
- **Fast compression probes for whole-repo archives.** Uses fast compression probes between exact boundary builds when pruning oversized whole-repo `.` archives in `extensions/oracle/lib/archive.ts` (see [Archive size probes](ARCHITECTURE.md#archive-size-probes)).
- **`agent-browser` `0.41.2` driver contract and prompt stdin transport.** Requires `agent-browser` `0.41.2` or newer, bounds driver commands (`agent_browser_timeout`), sends ChatGPT prompts over `batch` stdin with normalized length and SHA-256 checks before send, sets `AGENT_BROWSER_NO_WEBMCP=1` and `AGENT_BROWSER_NO_VERSION_CHECK=1`, closes only listed sessions, and removes `.config` and `.target` sidecars after `agent-browser session list` confirms absence.
- **Secret scrubbing and local path ownership checks.** Scrubs every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable by pattern before spawning browser, helper, or archive subprocesses, ignores symlinked, foreign-owned, or group/world-writable job directories and `job.json` files on POSIX, and refuses symlinked or foreign-owned `PI_ORACLE_STATE_DIR` roots.
- **CI, proofs, brand assets, and trusted publishing.** Runs the GitHub Actions local gate in `.github/workflows/ci.yml`, offline real-Chromium capture proof via `npm run proof:capture`, macOS and Ubuntu [Crabbox requirement](PLATFORM_SMOKE.md), GitHub Pages site and [brand assets](BRANDING.md), and OpenID Connect (OIDC) npm trusted publishing with provenance attestations in `.github/workflows/release.yml`.
- **Documentation.** Organized by reader role across `README.md` and `docs/`, verified by `npm run test:docs`.

Per-release changes are recorded in [Changelog](../CHANGELOG.md).

## Tracking upstream

A fresh clone has no remote for [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle); add one before you sync.

1. Merge upstream `main` with an explicit merge commit, never a rebase. Port the runtime and test changes the fork shares, and keep what the fork owns ([What the fork changes](#what-the-fork-changes)).
2. Record the sync at the top of [Sync record](#sync-record): the merge date, the upstream commit with its date and `pi-oracle` version, what was adopted, and what was reviewed and not adopted, with the reason.
3. Run `npm run verify:oracle`. A merge that touches archive packing, process cleanup, runtime or browser profile handling, package metadata, or the Crabbox harness also requires the platform runs in [Platform smoke](PLATFORM_SMOKE.md).
4. Land the merge commit on `main` by fast-forward, so `main` keeps the upstream commit as a parent.

Sync rules:

- **Merge, never rebase, and never squash a sync.** Shared upstream history stays intact through explicit merge commits. A squash merge drops the upstream parent: the 2026-10-31 sync landed that way, and GitHub reported the fork behind upstream until the next merge restored the ancestry ([Sync record](#sync-record)). Later changes are selectively ported where the fork's runtime and release gates diverge.
- **Release tags and version numbering.** Upstream's `v0.1.0`–`v0.7.20` tags remain in `fitchmultz/pi-oracle`. Their names collide with the fork's own `v*` tags, and a `v*` tag pushed to this repository starts `.github/workflows/release.yml`. The fork's `v*` tags and npm versions restarted at `0.1.0` (based on upstream `0.7.20`), and the [Changelog](../CHANGELOG.md) records the upstream base above the preserved upstream history divider.
- **Upstream contributions.** Fixes that are not specific to Oh My Pi are candidates for upstream pull requests; the relay transport, the managed browser, `/oracle-run`, and the `omp.pi-oracle.programmatic.v1` bridge remain fork-owned unless upstream requests them.

Community project; not affiliated with or endorsed by the Oh My Pi maintainers, the `pi-oracle` maintainer, OpenAI, or xAI.

## Sync record

### 2026-11-09 — upstream `bf2c031` (`pi-oracle` 0.7.27)

The latest recorded sync is upstream `bf2c031` (2026-11-03, `pi-oracle` 0.7.27), merged on 2026-11-09:

- `6759f3e` ([#74](https://github.com/fitchmultz/pi-oracle/pull/74)): adopted as the fork's own development baseline, `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `^1.5.0`. Pi 1.5.0 pins `undici` 8.12.3 and `minimatch` 11.0.3, so the fork's `undici` and `minimatch` overrides, which patched the 1.3.0 and 1.4.0 pins, are removed. Upstream's exact pins and its `protobufjs` override are not adopted; the fork keeps a caret range and needs no override.
- `74fb70d` ([#77](https://github.com/fitchmultz/pi-oracle/pull/77)), `205cbf1` and `21f0323` ([#79](https://github.com/fitchmultz/pi-oracle/pull/79), [#80](https://github.com/fitchmultz/pi-oracle/pull/80)), `88aa788` ([#83](https://github.com/fitchmultz/pi-oracle/pull/83)), and the 0.7.24–0.7.27 release commits: reviewed, not adopted; they move upstream's automatic release workflow (`npm-version.yml`) to newer reusable-workflow pins, which the fork's `.github/workflows/release.yml` trusted publishing replaces.

### 2026-10-31 — upstream `eecf79e` (`pi-oracle` 0.7.23)

The preceding sync, upstream `eecf79e` (2026-10-31, `pi-oracle` 0.7.23), landed as squash commit `a7b0918` ([#28](https://github.com/alphastorm/omp-oracle/pull/28)) without its upstream parent, so GitHub reported the fork behind upstream until the merge above restored the ancestry. Re-checked on 2026-11-02 before 0.4.12: upstream `main` is `bd91a5a` (`596d8b7`, [#72](https://github.com/fitchmultz/pi-oracle/pull/72) "Automate qualified Oracle releases (3/3)", and the 0.7.23 release chore); no file under `extensions/oracle/{lib,shared,worker}` changed, and the release-automation work serves upstream's pipeline, not the fork's Crabbox lanes and trusted publishing. Nothing ported.

- `5c31b3d` ([#68](https://github.com/fitchmultz/pi-oracle/pull/68)): ported case-insensitive bare-effort opener recognition, including removable chips, through `BARE_EFFORT_PATTERN`, and assistant headings marked `data-conversation-role="assistant"` through shared turn observation, capture, and archive-turn exclusion, each with red-before regression tests. Already covered: the shared `matchesModelConfigurationOpener` and its declaration, generic `Model` / `Model selector` and `Select ChatGPT model` buttons, compact Intelligence openers, model and effort chips, `Send` / `Send prompt` throughout upload/send readiness and DOM activation, and `Stop` throughout send acceptance and completion. The fork's bound-turn existence and rendered-generation checks already complete replies without `Copy response`, so upstream's `data-talvt-turn-state="complete"` fallback adds no missing completion path. The broader family-prefix opener is not adopted: the fork deliberately rejects `Pro feedback` and similar response actions while accepting numbered composer chips. The five-stop slider with picker reopen, stale-stop reload, one-per-job missing-turn reload, and timed-out recollection are unchanged; upstream's release metadata, documentation layout, and unpinned Ubuntu tool installs do not replace the fork's versions, docs, or pinned tooling.
- `ab82bd9` ([#69](https://github.com/fitchmultz/pi-oracle/pull/69)): reviewed, not adopted; retained-candidate transfer/checksums and native Windows SSH qualification serve upstream's release pipeline, while the fork's Crabbox macOS/Ubuntu lanes and `.github/workflows/release.yml` trusted publishing cover its release gate.
- `9141302` ([#70](https://github.com/fitchmultz/pi-oracle/pull/70)): reviewed, not adopted; target-specific preflight, custom macOS SSH ports, and native-host shell portability support split qualification rather than the fork's doctor-first macOS/Ubuntu release gate and `.github/workflows/release.yml` trusted publishing. The `invariants.mjs` / `doctor.mjs` changes add no missing fix for the fork's required lanes: provider and Windows-template checks are already conditional, both required targets run together, and preflight runs on a POSIX host rather than native Windows.
- `eecf79e` ([#71](https://github.com/fitchmultz/pi-oracle/pull/71)): reviewed, not adopted; the hosted-platform qualification workflow and `ci-release-hosted.sh` / `ci-release-windows.ps1` duplicate the fork-owned Crabbox macOS/Ubuntu release proof and `.github/workflows/release.yml` trusted publishing with a different automation contract.

### 2026-10-17 and 2026-09-22 — upstream `d658a98` (`pi-oracle` 0.7.22) and `4d96ffc`

The sync before it, upstream `d658a98` (2026-10-17, `pi-oracle` 0.7.22), ported the runtime fixes the fork shares: anonymous `ua-*` visitor sessions classified as signed out, `/oracle-auth` reads retried across CDP navigation with failure guidance that separates browser verification from rejected cookies, the `/oracle-auth` launch retry for a closing `agent-browser` daemon, and a `before_agent_start` guard for prompt-less custom-message turns on newer `pi` hosts; and the test-audit repairs (false-green assertions replaced by behavioral proof, the `loadConfigFn` test seam removed, npm 12 `npm pack --json` parsing, `ENOTEMPTY` cleanup retries). Not adopted: the native Linux Chromium v11 cookie importer (Linux Chromium users keep the documented safe-storage password override), the Pi 1.x development baseline and its shrinkwrapped dependency graph, the README and docs reorganization, npm auto-publish CI, the Ubuntu image bump, and the shared compatibility fleet; upstream's composer-label, Power-slider, and jobs-directory fixes were already covered by the fork. Re-checked on 2026-10-20, with upstream `main` still at `d658a98`: the fork has since moved to its own Pi 1.3 development baseline (`^1.3.0`, without upstream's pinned 1.0.0 and shrinkwrap; its `before_agent_start` guard now matches upstream's `"prompt" in event` form), has its own trusted-publishing release workflow in place of upstream's auto-publish CI, and reads Linux Chromium `v11` cookies through `@steipete/sweet-cookie` 0.4.4, which closes the gap upstream's native importer filled. The earlier sync, upstream `4d96ffc` (2026-09-22), imported cancellation-race and protected-profile test improvements plus a native Pi status smoke while keeping runtime code, package identity, CI, and release gates fork-owned.
