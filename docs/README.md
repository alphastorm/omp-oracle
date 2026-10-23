# Documentation

OMP Oracle is an extension for Oh My Pi and `pi` that sends a repository archive and prompt to
ChatGPT or Grok in a browser session, saves the answer to disk, and wakes the asking session when
it lands.

## Use it

- [Quickstart](../README.md) — decide whether OMP Oracle fits, install it, and finish a first job.
- [Operations](OPERATIONS.md) — configure the extension, set up a browser transport, inspect jobs, and troubleshoot failures.
- [Compatibility](COMPATIBILITY.md) — supported hosts, platforms, providers, transports, and known limits.

## Trust it

- [Security model](SECURITY.md) — what leaves the machine, default archive exclusions, credential handling, and trust boundaries.
- [Security policy](../SECURITY.md) — how to report a vulnerability privately and what is in scope.

## Build on it

- [Contributing](../CONTRIBUTING.md) — development workflow, required verification by change type, and repository layout.
- [Architecture](ARCHITECTURE.md) — component ownership, job lifecycle, transports, persistence, collection, and invariants.
- [Test plan](TEST_PLAN.md) — which check to run, isolated session smoke tests, failure-mode checks, and the auth recovery drill.
- [Platform smoke](PLATFORM_SMOKE.md) — cross-platform smoke runner setup, target checks, and artifacts.
- [Upstream](UPSTREAM.md) — relationship to `fitchmultz/pi-oracle`, preserved contracts, and fork changes.
- [Branding](BRANDING.md) — visual identity, color tokens, typography, voice, and artwork regeneration.

## Proposals

- [Conversation index and selected-chat recall](CONVERSATION_INDEX_PROPOSAL.md) — design discussion only; reuse pre-existing ChatGPT threads and support continuity across Oracle clients/platforms through explicit discovery, retrieval, and thread identity; not a supported feature.

## Dated records

- [Release](RELEASE.md) — the release procedure followed by the dated evidence ledger.
- [Changelog](../CHANGELOG.md) — release-by-release change history.

Current support claims live in [Compatibility](COMPATIBILITY.md); dated evidence lives in the
[release ledger](RELEASE.md#evidence-ledger).
