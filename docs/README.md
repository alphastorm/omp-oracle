# Documentation

OMP Oracle is an extension for the Oh My Pi and `pi` coding agents that sends a repository archive and prompt to ChatGPT or Grok in a browser session, saves the answer to disk, and wakes the asking session once; use this index to find the right guide.

## Use it

- [Overview and quickstart](../README.md) — decide whether OMP Oracle fits, install it, and get a first answer.
- [Operations](OPERATIONS.md) — configure `oracle.json`, set up a sign-in transport, work with jobs, automate Oracle from a program with `/oracle-run`, recover from failures, and look up every command, tool, config key, and environment variable.
- [Compatibility](COMPATIBILITY.md) — check the current release number, supported hosts, platforms, providers, sign-in transports, and known limits.

## Trust it

- [Security model](SECURITY.md) — verify the full default archive exclusion list, credential handling per sign-in transport, local file permissions, and trust boundaries.
- [Security policy](../SECURITY.md) — report a suspected vulnerability privately and check what is in scope.

## Build on it

- [Contributing](../CONTRIBUTING.md) — go from a clone to an accepted pull request, with required commands by change type, repository layout, and naming and commit rules.
- [Architecture](ARCHITECTURE.md) — understand the components, job lifecycle, sign-in transport invariants, state on disk, answer capture, session wake-ups, and cleanup before changing behavior.
- [Test plan](TEST_PLAN.md) — choose the verification check that proves a change and run isolated session smoke tests, failure-mode checks, or the auth recovery drill.
- [Branding](BRANDING.md) — apply the visual identity, color tokens, typography, voice, and artwork regeneration rules on the README, website, and artwork.

## Maintain it

- [Platform smoke](PLATFORM_SMOKE.md) — prepare local prerequisites and run the cross-platform smoke suites on macOS and Ubuntu.
- [Release](RELEASE.md) — run the release sequence, execute the release gate and live preset proof, verify npm provenance, and record evidence.
- [Upstream](UPSTREAM.md) — check what this fork preserves from `fitchmultz/pi-oracle`, what it changes, and how upstream merges work.

## Dated records

- [Release ledger](RELEASE.md#evidence-ledger) — inspect dated qualification and publication records for each release.
- [Changelog](../CHANGELOG.md) — read release-by-release user and maintainer changes.
- [Upstream sync record](UPSTREAM.md#sync-record) — inspect dated upstream merge notes.

Current support claims are in [Compatibility](COMPATIBILITY.md); dated qualification records are in the [release ledger](RELEASE.md#evidence-ledger).
