# Upstream

`omp-oracle` is a fork of [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle),
the `pi` extension that sends long-running work to ChatGPT or Grok through the web app. This
page records what the fork keeps, what it changes, and how it tracks upstream.

Companion docs: [Release](RELEASE.md) · [Compatibility](COMPATIBILITY.md) ·
[Changelog](../CHANGELOG.md)

## What is preserved

- Git history. The fork was created from upstream `main` at the `upstream-compat-20260918`
  merge and keeps every upstream commit.
- The agent- and user-facing contracts: `/oracle`, `/oracle-followup`, `/oracle-auth`,
  `/oracle-read`, `/oracle-status`, `/oracle-cancel`, `/oracle-clean`; `oracle_preflight`,
  `oracle_auth`, `oracle_submit`, `oracle_read`, `oracle_cancel`; and the prompt templates.
- The durable job format under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, the
  `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, and the
  `omp.pi-oracle.programmatic.v1` bridge symbol, so existing configurations, saved jobs, and OMP
  integrations keep working.
- The validation harness: `npm run verify:oracle`, the sanity harness, the Crabbox platform
  gate, and the ChatGPT preset proof.
- The MIT license and upstream authorship. Mitch Fultz is credited as a contributor in
  `package.json` and in the README.

## What the fork changes

- **Package identity.** The npm name is `omp-oracle`, published by
  [alphastorm](https://github.com/alphastorm). `pi-oracle` on npm remains upstream's package and
  does not carry fork commits; the two must not be installed side by side.
- **Existing-Chrome relay transport** for ChatGPT (`browser.chatGptRelayEndpoint`): one pinned,
  job-owned tab in an already signed-in Chrome, with ownership-checked cleanup and no cookie
  copying. See [Architecture](ARCHITECTURE.md#existing-chrome-relay-transport).
- **OMP host compatibility.** Node worker launch, project-trust handling on hosts without Pi's
  trust exports, transient ChatGPT 403 classification, and the programmatic bridge that exposes
  the preflight and submit contract to OMP.
- **ChatGPT UI drift fixes** carried ahead of upstream: versioned Pro controls, the `Power` plus
  checked `Latest` transition, and compact model menus on continuation pages.
- **Documentation** laid out like the other `omp-*` projects.

The exact list per release is in [`CHANGELOG.md`](../CHANGELOG.md).

## Tracking upstream

- Upstream is merged, not rebased, so the shared history stays intact and each upstream release
  lands as one merge commit (the last one is `upstream-compat-20260918`).
- Upstream's release tags (`v0.1.0` through `v0.7.20` of `pi-oracle`) are not carried in this
  repository; they remain in `fitchmultz/pi-oracle`. The fork's `v*` tags name `omp-oracle`
  releases only, starting at `v0.1.0`.
- After a merge, the local gate (`npm run verify:oracle`) must pass; changes that touch archive
  behavior, process cleanup, runtime/browser profile handling, package metadata, or the Crabbox
  harness also need the focused platform runs described in
  [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md).
- Fixes that are not OMP-specific are candidates to send back upstream. The relay transport and
  the OMP bridge stay in the fork unless upstream wants them.
- Version numbers restart at `0.1.0` for the new package identity; they do not continue
  upstream's `0.7.x` line. The fork's `CHANGELOG.md` records which upstream version each
  release is based on, and the inherited upstream history stays below its own divider there.

`omp-oracle` is a community project. It is not affiliated with or endorsed by the Oh My Pi
maintainers, the `pi-oracle` maintainer, OpenAI, or xAI.
