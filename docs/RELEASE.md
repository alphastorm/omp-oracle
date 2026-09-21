# OMP Oracle release

How a change becomes a published `omp-oracle` release, and the evidence ledger behind the
current state. The gate is local and Crabbox-driven; hosted CI runs only the cheap local gate.

Companion docs: [Test plan](TEST_PLAN.md) · [Platform smoke](PLATFORM_SMOKE.md) ·
[Architecture](ARCHITECTURE.md) · [Upstream](UPSTREAM.md) · [Changelog](../CHANGELOG.md)

## Package identity

- npm name: `omp-oracle`. The `pi-oracle` package on npm is the upstream project published by
  its maintainer; it does not carry this fork's commits.
- Version: the fork's own line, starting at `0.1.0`. It does not inherit upstream's `0.7.x`
  numbering; `0.1.0` was based on upstream `pi-oracle` 0.7.20, and later releases add the changes
  listed per version in [`CHANGELOG.md`](../CHANGELOG.md).
- The GitHub URL install tracks `main`; npm carries the released versions
  ([README](../README.md#build-and-run)).
- Runtime identifiers are unchanged by the rename: `/oracle*` commands, `oracle_*` tool names,
  `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, the job directory format, and the
  `omp.pi-oracle.programmatic.v1` bridge symbol.

## Validation workflow

Use the narrowest workflow that proves the change:

| Situation | Command(s) |
| --- | --- |
| Everyday local iteration | `npm run verify:oracle` |
| Platform-focused syntax/invariant sanity | `npm run check:platform-smoke`, `npm run sanity:oracle:platform` |
| Platform-sensitive runtime changes | `npm run smoke:platform:doctor`, then a focused `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` |
| Platform matrix proof | `npm run smoke:platform:all` |
| ChatGPT preset release proof | `npm run release:proof:chatgpt-presets` |
| Publish/release gate | `npm run release:check` |

`npm test` runs `npm run verify:oracle`; it is not a separate gate. Platform-sensitive changes
include archive behavior, process cleanup, runtime/browser profile handling, package metadata,
Crabbox harness code, or anything that may differ across macOS, Linux, and Windows.

## Release gate

`npm publish` is guarded by `prepublishOnly`, which runs `npm run release:check`:

1. `npm run verify:oracle` — syntax and bundle checks, helper unit tests, the three typecheck
   projects (extension, worker helpers, worker runtime), the isolated sanity harness, and
   `npm pack --dry-run`.
2. `npm run release:proof:chatgpt-presets` — fresh live ChatGPT preset proof for every canonical
   preset through the loaded extension.
3. `npm run smoke:platform:all` — doctor-first macOS and Ubuntu Crabbox suites (`platform-build`
   and `real-extension`) using packed-install proof, not source-tree `pi -e` loading.
   `windows-native` is an available target but not release-required; see
   [Compatibility](COMPATIBILITY.md#platforms-and-runtime).

The order matches the release order: cheap harness checks, fresh live preset proof, doctor,
full matrix, then artifact review.

### ChatGPT preset proof

Before a release, run live jobs through the loaded extension for every ChatGPT preset in
`ORACLE_SUBMIT_PRESETS`. Each prompt must make the saved response contain the exact markers
`PRESET <preset> OK` and `PACKAGE omp-oracle`. The runner submits one such job per canonical
preset from isolated OMP print-mode sessions (isolated agent dir, sessions, jobs, and state under
`/tmp/omp-oracle-proof`; relay transport; this checkout's extension source), waits for each to
complete, writes `.artifacts/chatgpt-preset-proof/latest.json`, and runs the checker:

```bash
PI_ORACLE_PROOF_MODEL=<omp model id> PI_ORACLE_PROOF_MODELS_YML=<models.yml for that model> \
  npm run release:proof:chatgpt-presets:run
```

`PI_ORACLE_PROOF_MODEL` is the model the isolated session uses to call `oracle_submit` (a zero-cost
local model is fine); its `models.yml` is copied into the isolated agent dir because that dir has no
other configuration. The relay endpoint selects the signed-in Chrome, i.e. the ChatGPT account the
eight live jobs consume, so it has no default: the runner takes `PI_ORACLE_PROOF_RELAY` when set and
otherwise `browser.chatGptRelayEndpoint` from the operator's agent-scope config
(`$PI_CODING_AGENT_DIR/extensions/oracle.json`, default `~/.omp/agent/extensions/oracle.json`),
the same account the operator's real jobs use; it prints the resolved endpoint and its source
before the first submit and refuses to run when neither is set. `--dry-run` resolves everything and
prints the plan without submitting. Pass preset ids as arguments to rerun a subset; a partial rerun
keeps the other presets' entries from the existing proof file. The manual equivalent starts from
the checked, intentionally non-valid template:

```bash
mkdir -p .artifacts/chatgpt-preset-proof
node scripts/oracle-chatgpt-preset-proof.mjs template > .artifacts/chatgpt-preset-proof/latest.json
npm run release:proof:chatgpt-presets
```

The checker fails if the proof is missing, stale, tied to a different package name, version, or
git head, references jobs that completed before the current commit, or lacks actual persisted
ChatGPT `.tar.zst` job state and response text for any canonical preset.

Ordinary pre-commit smoke runs can use `instant` or `thinking_light`; release proof must cover
every canonical model preset (the eight non-tool presets) through the loaded extension.
`deep_research` is a composer-tool preset and is excluded because each run consumes a Deep
Research task; the checker prints the exclusion.

### Real runtime suite defaults

The real runtime suite defaults to deterministic installed-tool execution so platform proof
stays bounded. Provider/model defaults remain `zai/glm-5.2` for doctor/config and optional
model-agent debugging; override with `PI_ORACLE_REAL_TEST_PROVIDER` and
`PI_ORACLE_REAL_TEST_MODEL`. For inner-loop source loading only, use `npm run smoke:real:source`;
it is not release proof. Set `PI_ORACLE_REAL_TEST_MODEL_AGENT=1` only when debugging the slower
model-agent path. The optional second real-agent negative symlink check is opt-in via
`PI_ORACLE_REAL_TEST_NEGATIVE_SYMLINK=1`; `npm run sanity:oracle` covers archive/symlink rejection
by default.

## Evidence ledger

Fork entries come first; entries carried from the upstream `pi-oracle` design document follow
under their own heading and were recorded against the upstream package identity.

### Fork evidence (omp-oracle)

Recorded by the fork under the `omp-oracle` name, on the maintainer's macOS workstation.
Artifact run ids live under the gitignored `.artifacts/` root.

#### 0.3.2 (2026-09-21, `0e064ea`)

- Two defects with one cause, both found by running real jobs rather than by the gate. ChatGPT
  now labels a freshly streamed assistant turn's action bar `Copy` and only renames it
  `Copy response` once the turn is re-rendered from persistence, so the completion loop's
  `Copy response` count matched no live turn: two independent instrumented jobs sat at
  `copyCount=0` with a stable complete `targetLen=23` for over seven minutes, bound for the
  90-minute completion timeout. Removing that gate then exposed the second defect, which had
  already shipped in `0.3.1`: a job captured a 3-byte response (`ACT`) and recorded
  `collectionStatus: complete` with no gaps, while `oracle_read({ action: "recollect" })` on the
  same binding returned the full 38 bytes.
- Root cause, reproduced deterministically against the live relay after two wrong hypotheses were
  disproved by measurement: stop-control label drift was ruled out (`chatGptStreamingVisible`
  correctly read `Stop answering` throughout a stream) and layout-dependent `innerText` was ruled
  out (the whitespace-squeezed `innerText` and `textContent` lengths were equal, so both reads
  were short). The job-owned pinned relay tab reports `visibilityState: "hidden"`, and Chrome
  gives a hidden tab no rendering opportunities, so ChatGPT stops materializing the streamed
  turn: a tracer watched a turn freeze at 90 characters and stay frozen for 21 s while the stop
  control cleared at the same time, because that control follows the network stream rather than
  the DOM. `Target.activateTarget` and `Page.setWebLifecycleState` both return success and leave
  the tab hidden, so there is no CDP self-heal. A reloaded conversation renders the committed
  turn correctly while hidden, which is why recollection always returned the whole response.
- Remediation is `5b6c220`: generation state is the authority for "finished"
  (`chatGptGenerationActive` prefers the `[data-testid="stop-button"]` reading and falls back to
  the accessibility labels when that test id drifts), the bound turn only has to exist rather
  than expose a particular label, and the streamed read became a lower bound — the worker reloads
  the persisted conversation, polls the re-read to stability, keeps whichever read is longer, and
  logs the recovered characters. Proved by injecting a frozen 30-character streamed read into the
  shipped path: `Recovered 297 character(s) ... (streamed 30, committed 327)`, with the prompt's
  end marker present in the saved response.
- The fix then fired unprompted during the release proof itself: the `instant` job `ca7ac0f1`
  logged `Recovered 11 character(s) the streamed turn had not rendered (streamed 25, committed
  36)`. Without the reconciliation that job would have saved `PRESET instant OK` without
  `PACKAGE omp-oracle`, so the preset proof would have failed on a missing marker.
- Class closure for a defect that nearly shipped inside this fix: `run-job.mjs` is excluded from
  both typecheck projects, so a missing import there fails only at runtime, mid-job, after a
  provider call has been spent — `isConversationPathUrl` was used without being imported and no
  gate saw it. `npm run check:worker-runtime-names` runs TypeScript's `checkJs` pass over the
  worker runtime and rejects unresolved-identifier diagnostics; it reports the remaining 22
  non-fatal type diagnostics without failing on them. Proved red (`Cannot find name
  'isConversationPathUrl'`) and green, and wired into `npm run verify:oracle`.
- Local gate: `npm run verify:oracle` green on the remediation and release-prep states — 31
  helper tests, both typechecks, the new worker runtime name check, the sanity harness, and
  `npm pack --dry-run`.
- Live eight-preset ChatGPT proof against `0e064ea` (`npm run release:proof:chatgpt-presets`
  accepted), routed to the diligence account with `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`:
  `pro_standard` `1bdd024d`, `pro_extended` `c6c277a0`, `thinking_light` `607acedb`,
  `thinking_standard` `3fe1d31c`, `thinking_extended` `aab46e23`, `thinking_heavy` `d53b11a0`,
  `instant` `ca7ac0f1`, `instant_auto_switch` `1523d759`; all eight completed with both markers.
  `thinking_light` first failed once with an unrelated transient (`Could not open model
  configuration UI` at the 45 s open timeout, on a leftover `6 Pro` composer chip, on a code path
  this release does not touch and which passed the same preset in the same order 40 minutes
  earlier); it was rerun alone and the proof file was assembled from that rerun plus the seven
  recorded outcomes. The checker independently revalidates every job directory, package identity,
  git head, and completion time on disk, so no entry is taken on trust.
- Crabbox lanes on `0e064ea`: macOS `platform-build` PASS (54.2 s) and `real-extension` PASS
  (5.1 s), Ubuntu `platform-build` PASS (40.9 s) and `real-extension` PASS (4.5 s).
  `npm run release:check` then passed as one composition on the same clean tree.
- Published `omp-oracle@0.3.2` from `0e064ea`. As with `0.3.1`, npm two-factor authentication
  (`auth-and-writes`) requires an interactive approval, and the composition had just passed on the
  unchanged tree, so the maintainer completed the publish with `npm publish --ignore-scripts` and
  `prepublishOnly` did not re-run inside that invocation. `npm publish --dry-run --ignore-scripts`
  on the same tree reported the published artifact: shasum
  `0caa74b724e98971cbaccd6dcd5c53fca2394b75`, 81 files. Tag `v0.3.2` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.2) name the same
  commit.

#### 0.3.1 (2026-09-21, `5e59527`)

- Model-configuration settle boundary, found by the release gate and reproduced before it was
  fixed: the eight-preset proof against the release-prep commit `11790e9` came back red with
  `thinking_standard` and `thinking_extended` both applying their power stop and then failing
  after the full 20 s settle timeout (`Could not verify requested model settings after
  configuration for thinking`), while `thinking_light` and `thinking_heavy` settled in 0.5 s on
  the same family. The captured failure snapshots name the cause: ChatGPT left the compact
  intelligence menu mounted (`menu "Medium"`, `menu "High"`) with the composer opener already
  reporting `expanded=false` and the composer usable. `COMPACT_INTELLIGENCE_MENU_PATTERN` matches
  a bare tier label, so `snapshotHasModelConfigurationUi` stayed true for the whole deadline and
  the strongly-verified escape at the end of the settle loop is gated on that same predicate; the
  identical clause in `hasCompactIntelligenceMenuContext` separately suppressed the composer-chip
  read, so one root cause produced both symptoms. Remediation is `5e59527`: a single
  `hasOpenCompactIntelligenceMenu` helper used by both predicates, discarding a menu contradicted
  by its own collapsed opener and still treating an opener-less menu as open. Proved red then
  green as a unit test over the two real snapshots (`chatgpt-ui-helpers.test.mjs`, 12 pass/1 fail
  before and 13 pass after), then live: both presets completed with both markers.
- Local gate: `npm run verify:oracle` green on both the release-prep and remediation states —
  30 helper tests, both typechecks, the isolated sanity harness, and `npm pack --dry-run`.
- Live eight-preset ChatGPT proof against `5e59527` (`npm run release:proof:chatgpt-presets`
  accepted): `thinking_standard` `3029a182`, `thinking_extended` `c36539fc`, `pro_standard`
  `ec9c2604`, `pro_extended` `85722ae5`, `thinking_light` `d0deb147`, `thinking_heavy`
  `4112914f`, `instant` `ade29583`, `instant_auto_switch` `30e51906`; all eight completed with
  both markers. `deep_research` is excluded and the exclusion is printed. The run was routed to
  the maintainer's dedicated diligence ChatGPT account by passing
  `PI_ORACLE_PROOF_RELAY=http://127.0.0.1:9333`; the runner's `9224` default would have reached
  the personal browser relay instead. Provider latency was far higher than the 0.3.0 run
  (39 s–6.8 min per job against 42–68 s), entirely in the response phase — model configuration
  stayed under a second in every job.
- Crabbox lanes on `5e59527`: macOS `platform-build` PASS (50.2 s) and `real-extension` PASS
  (4.7 s), Ubuntu `platform-build` PASS (37.2 s) and `real-extension` PASS (4.5 s).
  `npm run release:check` then passed again as one composition inside `prepublishOnly`, on the
  same clean tree, during the first publish attempt; that attempt reached the registry and was
  refused only at npm two-factor authentication (`EOTP`, account mode `auth-and-writes`).
- Published `omp-oracle@0.3.1` from `5e59527`. Because the composition had just passed on the
  unchanged tree and an interactive one-time password would have expired during a second
  ~2.5-minute gate run, the maintainer completed the publish with `npm publish --ignore-scripts`;
  `prepublishOnly` therefore did not re-run inside the successful invocation. `npm publish
  --dry-run --ignore-scripts` on the same tree reported the artifact that was published: shasum
  `e4630e27ba8f8b755758995d8c63ad2b5f8d0e09`, 81 files, `omp-oracle-0.3.1.tgz`. Tag `v0.3.1` and
  the [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.1) name the
  same commit.

#### 0.3.0 (2026-09-20, `9f26e9c`)

- Native research export boundary, reproduced before it was fixed: against an owned headless
  Chromium (`node scripts/oracle-capture-proof.mjs`), a sandboxed cross-origin report frame whose
  Export → Export to Markdown menu delegates the download to the host page made the in-frame
  byte hook fail with `Native control did not expose downloadable bytes.` while Chrome itself
  wrote the export; the pre-armed collector (`Page.downloadWillBegin`/`downloadProgress` plus the
  object-URL registry) then recovered bytes identical to the file Chrome saved, bound to the tab's
  main frame. A probe on the maintainer's real Chrome 153 through the OMP relay confirmed the
  transport: `Browser.setDownloadBehavior` is not routed (`-32601`), `Page` download events are
  forwarded for both the page and the OOPIF session, and a 74-byte probe export was collected
  identical to the saved file (removed afterwards by exact path and content hash).
- One authorized collection-only tracer on a previously completed Deep Research job (private
  diligence run; identifiers withheld) recollected the report's native Markdown export: 36,995
  bytes, SHA-256 equal to the operator's earlier manual export, `blob` source from the host main
  frame, validated and stored under `artifacts/`, `collectionStatus: complete` with no gaps, tab
  closed with no cleanup warnings. The first two attempts exposed and fixed, with regressions: an
  extension poller in another session terminating the recollecting worker as a stale terminal
  cleanup worker (predecessor `lastCleanupAt` outranking the fresh heartbeat), and
  `agent-browser close` returning while its daemon still served a same-name `open` (orphan tab,
  then `Connection refused`).
- Focused cross-family review of the candidate (`review-daybreak-blue`, lead Claude; subject
  `54460e8`): nine findings, all lead-verified and dispositioned — eight mitigated with executable
  regressions and one partially mitigated/accepted (identity-less positional roots still bind by
  content hash and are refused at recollection). Remediation is `9f26e9c`.
- Local gate: `npm run verify:oracle` green on the feature, release-prep, and remediation
  states; the helper suite includes the fake-relay collector tests and the sanity harness the
  live-recollection reconcile case.
- Isolated loaded-extension smokes through `omp --standard … --no-extensions -e` with a local
  model: whole-repo archive exclusions (job `a9d41f6e`, `.pi/`, `.oracle-context/`, `.cursor/`,
  `.scratchpad.md`, `.artifacts/` excluded, README present; isolated worker failed cleanly on
  auth), symlink escape rejection (no job created), and `oracle_read({ action: "recollect" })`
  on the completed instant canary `b5dca6b9` (complete in 4 s, provenance restored). Agent
  feedback led to the `collection-binding:` summary line; the `touch`-only seed marker in the
  test plan was found to be rejected at submit time and corrected to a timestamped marker.
- Live eight-preset ChatGPT proof against `9f26e9c` (`npm run release:proof:chatgpt-presets`
  accepted): `instant` `e0d780a8`, `instant_auto_switch` `577ecd41`, `thinking_light`
  `b310013c`, `thinking_standard` `7b038f37`, `thinking_extended` `d887033e`, `thinking_heavy`
  `1a2b9d1f`, `pro_standard` `05775d87`, `pro_extended` `f7d1e39a`; all eight completed with
  both markers in 42–68 s. `deep_research` is excluded and the exclusion is printed.
- Crabbox lanes on `9f26e9c`: macOS `platform-build` PASS (52.6 s) and `real-extension` PASS,
  Ubuntu `platform-build` PASS (37.8 s) and `real-extension` PASS; `npm run release:check` passed
  as one composition, and again inside `prepublishOnly` during the publish.
- Published `omp-oracle@0.3.0` from `9f26e9c` (registry `gitHead` matches): shasum
  `25fd2d0ccd7e16256b86c5904976ac71ca51227a`, 81 files, dist-tag `latest`; tag `v0.3.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.3.0) name the same
  commit. A fresh `npm pack omp-oracle@0.3.0` reproduces the shasum and carries
  `worker/response-capture.mjs` and `shared/relay-cdp-client.mjs`; the repository-only proof
  scripts are not shipped.

#### 0.2.0 (2026-09-20, `6401cfc`)

- Deep Research acceptance through the fork's build and the relay transport: job
  `00f41969-f0ab-458d-a348-0124ad75465a` enabled and verified the composer tool, armed frame
  capture, attached the widget frame, held heartbeats across the research phase, and completed
  with a 13,550-character report in 5 minutes; after the two-counter header fix, job
  `4dc1d412-8f3f-4ca6-8434-25f60100bac6` completed with a clean body in 4m20s. Earlier attempts
  recorded each designed failure with its own code: `deep_research_toggle_not_found`,
  `deep_research_clarification_requested`, `deep_research_report_unreadable`. Spike captures:
  `.artifacts/deep-research-spike-2026-09-20/`.
- CDP frame capture works through the unmodified OMP 18.2.6 relay; no relay change was needed.
  The earlier "relay cannot expose frames" reading came from arming `Target.setAutoAttach` after
  the frame already existed, and from reading the OOPIF shell instead of its same-origin child.
- Live eight-preset ChatGPT proof re-run against `6401cfc` (`npm run release:proof:chatgpt-presets`
  accepted): `instant` `2cd01096`, `instant_auto_switch` `1cb07f93`, `thinking_light` `f0724ffc`,
  `thinking_standard` `603c27cf`, `thinking_extended` `76710d74`, `thinking_heavy` `8a1a5286`,
  `pro_standard` `438e5f62`, `pro_extended` `e5ff58c9`; all eight completed with both markers.
  `deep_research` is excluded and the exclusion is printed.
- `npm run release:check` passed as one composition on `6401cfc` (local gate, preset proof, macOS
  and Ubuntu Crabbox lanes), and again inside `prepublishOnly` during the publish.
- Published `omp-oracle@0.2.0` from `6401cfc`: shasum
  `93d61ccecbcf527456a4f884cc1d6e5857ea72ca`, 78 files; tag `v0.2.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.2.0) name the same
  commit. A fresh `npm install omp-oracle@0.2.0` carries the `deep_research` preset and
  `shared/relay-cdp-client.mjs`.

#### 0.1.0 (2026-09-20, `85adab1`)

- Local gate: `npm run verify:oracle` green on macOS (Node 26) and inside `cimg/node:24.16`
  (Node 24.16.0); the same gate passed on the first hosted CI run.
- Packed install through pi 0.80.9 on macOS: `npm run smoke:real:packed` installed
  `./node_modules/omp-oracle` via `pi install -l --approve`, `pi list` showed the packed path, and
  `/oracle-status` executed through the installed package (`.artifacts/real-smoke/run-1789870710142-vyc342`).
- Ubuntu Crabbox lane: `platform-build` PASS (`run-1789871615787-33if6p`, packed tarball installed
  from `node_modules/.bin/pi` inside the container, `pi list` showed `node_modules/omp-oracle`) and
  `real-extension` PASS (`run-1789871654549-uee638`) against `omp-oracle-platform-smoke:node24`.
- OMP 18.2.6: `omp install --dry-run .` resolves the checkout as `omp-oracle`.
- Live ChatGPT tracer through the fork's build and the relay transport (2026-09-20): job
  `020385c2-773f-4130-a469-30edcec17579` failed at `configuring_model` on the slider-based
  composer (`Could not find model family control for instant`); after the slider driver landed,
  job `9d4012f3-e48b-45c7-93c6-66822b3fdd29` set `Instant (1 of 5)`, uploaded, and completed with
  both response markers in 40 s. Diagnostics: `.artifacts/ui-drift-2026-09-20/`.
- Live eight-preset ChatGPT proof through the fork's build and the relay transport (2026-09-20,
  `npm run release:proof:chatgpt-presets` accepted): `pro_standard` `61006224`, `pro_extended`
  `d6b3b72a`, `thinking_light` `92c9871f`, `thinking_standard` `4afd8411`, `thinking_extended`
  `9115eb5e`, `thinking_heavy` `7332f139`, `instant` `7b941e0c`, `instant_auto_switch`
  `d3605d00`; every job completed with `PRESET <preset> OK` and `PACKAGE omp-oracle`, Pro
  presets on the single `Pro` stop. The proof is re-run against the release commit before
  publishing, because the checker binds jobs to the current HEAD.
- macOS Crabbox lane (SSH to localhost, 2026-09-20): `platform-build` PASS
  (`run-1789875191134-adr3y0`) and `real-extension` PASS (`run-1789875241370-75h0od`); the full
  `npm run release:check` then passed as one composition on `85adab1`, and again inside
  `prepublishOnly` during the publish. The Windows native lane is not release-required for the
  fork.
- Published `omp-oracle@0.1.0` on 2026-09-20 from `85adab1`: shasum
  `943f969b35348963f105b7d46dd33d08b4fc99d3`, 76 files; tag `v0.1.0` and the
  [GitHub release](https://github.com/alphastorm/omp-oracle/releases/tag/v0.1.0) point at the same
  commit, and `omp install --dry-run omp-oracle` resolves it from the registry.

### Carried upstream evidence

The entries below are carried from the upstream `pi-oracle` design document. They were recorded
against the upstream package identity and the Pi baseline named in each entry, on the upstream
maintainer's machines. What has been observed on Oh My Pi is recorded in
[Compatibility](COMPATIBILITY.md#hosts).

### Current implementation status

Implemented in code for the pivot and concurrency redesign:

- config now uses `browser.*` + `auth.*`
- `/oracle-auth` now syncs real-Chrome ChatGPT cookies into the authenticated seed profile instead of opening a manual-login browser
- `oracle_submit` supports follow-ups via persisted `chatUrl`
- job state no longer stores CDP verification fields
- workers now run with per-job runtime sessions and per-job runtime profile clones
- runtime admission is controlled by runtime leases and `browser.maxConcurrentJobs`
- queued jobs are workerless and do not consume runtime or conversation leases until promotion
- follow-up jobs now acquire conversation leases
- persisted job state now records explicit lifecycle phases instead of relying only on coarse statuses
- poller notifications now use per-job notification claims rather than broad global scan serialization
- worker now uses a structured ChatGPT page-state classifier
- worker now downloads artifacts directly with `agent-browser download <ref> <dest>`
- poller scans are now best-effort/non-fatal with per-session in-flight guards
- worker heartbeats during artifact downloads, writes artifact manifests incrementally, and reopens the saved conversation before artifact capture/download
- artifact-only responses are treated as valid completion content
- the repo now includes a repeatable sanity harness: `npm run sanity:oracle`
- the repo now includes a safe expired-auth recovery drill: [`docs/TEST_PLAN.md`](TEST_PLAN.md)
- worker closes the isolated browser, removes the runtime profile, and releases leases in `finally`

Retained from the earlier MVP:

- `/oracle`, `/oracle-followup`, `/oracle-read`, `/oracle-status`, `/oracle-cancel`, `/oracle-clean`
- `oracle_auth`, `oracle_submit`, `oracle_read`, `oracle_cancel`
- detached background worker model
- `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` state layout
- shell-safe archive creation using tar streams: `zstd` compression for ChatGPT and gzip compression for Grok
- private permissions and atomic writes
- stale-worker reconciliation
- upload ordering: attach → confirm → fill → send
- current-turn response anchoring
- plain-text canonical response extraction
- wake-the-agent poller integration
- unique archive filenames per job
- worker PID identity checks using recorded process start time
- composer-scoped upload confirmation
- stable `chatUrl` capture after send
- redacted `oracle_read` details and same-project job scoping
- serialized poller scans

### Live validation status

Live-validated after the concurrency redesign:

- `/oracle-auth` happy path still works against the seed profile
- headless normal oracle runs still work using per-job runtime clones
- two concurrent runs in different projects work with isolated runtimes
- two concurrent runs in the same project but different `pi` sessions work when they target different conversations
- same-conversation concurrent follow-up rejection works and fails fast with a clear lease error
- runtime profile cleanup works on completion and cancellation
- runtime/conversation lease cleanup works on completion and cancellation
- global browser args overrides (for example `--disable-gpu`) apply to real jobs
- artifact-producing runs work with direct `download <ref> <dest>`
- multi-artifact runs complete, target the correct `pi` session, and persist both downloaded files with correct contents
- the poller no longer needs the worker to stay alive just to observe completion for artifact-producing runs
- expired/missing auth now fails as a clean auth-related error instead of generic UI/config drift
- `/oracle-auth` repairs the seed profile and a post-repair probe succeeds again
- live auth recovery also exposed and corrected a real source-profile misconfiguration during validation; the configured browser profile must actually contain the active ChatGPT session cookies

### Known remaining work

Still to verify live after this pivot:

- full ChatGPT preset release matrix evidence must be refreshed before any release; `npm run release:proof:chatgpt-presets` blocks release without one completed loaded-extension ChatGPT job for every canonical preset
- optional richer terminal semantics for partial artifact failure (`complete_with_artifact_errors`) in more live scenarios

### Production readiness criteria

This architecture is now live-validated for the core release path:

- no interaction with the user’s real Chrome during normal jobs
- no focus disruption during normal jobs
- the seed profile survives browser restarts and can be cloned into runtime profiles repeatedly
- different projects / sessions can run in parallel without co-mingled data
- same-conversation follow-ups are rejected while another job owns that conversation lease
- artifact capture works without `chrome://downloads`
- artifact-only responses and multi-artifact responses both complete correctly
- same-thread follow-ups reopen correctly from persisted `chatUrl`
- failure modes are clearly classified as auth / challenge / outage / UI drift
- expired/missing auth now fails cleanly, `/oracle-auth` repairs the seed profile, and the post-repair probe succeeds again

#### Current readiness summary

Current release blockers for the validated scope:
- release is blocked until fresh loaded-extension ChatGPT preset proof passes `npm run release:proof:chatgpt-presets` for every canonical `ORACLE_SUBMIT_PRESETS` id

Remaining non-blocking hardening work:
- broaden live proof of the new lifecycle/state-machine model across more degraded paths
- broaden live proof of notification-claim semantics under more concurrent completions
- extend regression-harness coverage for browser/download failure classes
- polish partial-artifact terminal semantics (`complete_with_artifact_errors`)
- keep hardening model-selection verification against future ChatGPT UI variation

Recent proof points:
- Pi 0.80.7 local gate: `npm run verify:oracle` passed on 2026-07-14, including syntax/bundle checks, both typechecks, the isolated sanity harness, and `npm pack --dry-run`
- Pi 0.80.7 safe loader smokes: `.artifacts/real-smoke/run-1784068526377-67yb2l` passed source loading, and `.artifacts/real-smoke/run-1784068527234-t2a5xm` passed packed-install loading through the real Pi CLI; both executed `/oracle-status` without creating an external oracle job or requiring provider credentials
- Pi 0.80.6 local gate: `npm run verify:oracle` passed three consecutive runs on 2026-07-11; each run completed syntax/bundle checks, both typechecks, the isolated sanity harness, and `npm pack --dry-run` without an `ENOTEMPTY` cleanup failure
- Pi 0.80.6 safe loader smokes: `.artifacts/real-smoke/run-1783810473367-cn72at` passed source loading, and `.artifacts/real-smoke/run-1783810475290-hj0pfs` passed packed-install loading through the real Pi CLI; both recorded `pi --version` as 0.80.6 and executed `/oracle-status` without creating an external oracle job or requiring provider credentials
- Pi 0.80.2 local gate: `npm run verify:oracle` passed on 2026-06-24 after the JSON command output, prompt-manifest, schema, and lazy Chrome-probe audit fixes
- Pi 0.80.2 isolated extension smokes: `.artifacts/real-smoke/run-1782321054924-jnq0x3` passed source proof, and `.artifacts/real-smoke/run-1782321056224-yuq5a2` passed packed-install proof
- Pi 0.80.2 JSON command smoke: `pi --no-extensions -e ./extensions/oracle/index.ts --mode json --no-session --no-approve "/oracle-status"` emitted displayed `oracle-command-output` JSON events
- Pi 0.79.10 local gate: `npm run verify:oracle` passed on 2026-06-22 after the 0.79.10 baseline refresh and `CONFIG_DIR_NAME` cleanup
- Pi 0.79.10 isolated extension smokes: `.artifacts/real-smoke/run-1782137209549-0xe67z` passed packed-install proof, and `.artifacts/real-smoke/run-1782137217821-95a1po` passed source model-agent proof
- Pi 0.79.10 platform artifacts: `.artifacts/platform-smoke/run-1782137574391-7lay68` (macOS platform-build), `.artifacts/platform-smoke/run-1782137619352-gku7jz` (macOS real-extension), `.artifacts/platform-smoke/run-1782137587082-d7kg4p` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1782137619176-lgxezy` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1782137625964-66z0oc` (Windows native platform-build), `.artifacts/platform-smoke/run-1782137752969-pbmdj1` (Windows native real-extension)
- Pi 0.79.10 isolated agent feedback: `.artifacts/isolated-agent-feedback/run-1782137385` confirmed local extension loading and useful `oracle_preflight` output after the path-label polish
- Pi 0.79.1 release gate: `npm run release:check` passed on 2026-06-11 after the project-trust, prompt-history, ChatGPT selector, and send-acceptance updates, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.1 platform artifacts: `.artifacts/platform-smoke/run-1781196218405-311wzs` (macOS platform-build), `.artifacts/platform-smoke/run-1781196261807-eb0391` (macOS real-extension), `.artifacts/platform-smoke/run-1781196230636-ze1hai` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1781196265638-kxiwh9` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1781196255488-ucuf35` (Windows native platform-build), `.artifacts/platform-smoke/run-1781196369098-4qlzjs` (Windows native real-extension)
- Pi 0.79.1 live source-extension send-acceptance smoke: new-chat job `4b98776f-d422-4bfb-8a6a-7aef73c31bf6` reached `https://chatgpt.com/c/6a2ac99d-fc5c-83e8-88d7-5e1e8f427499` and completed; same-thread follow-up job `abb4f590-96a1-4aab-b91a-c0a7cc15a162` completed on the unchanged conversation URL after send-acceptance evidence
- Pi 0.79.0 release gate: `npm run release:check` passed on 2026-06-08, including `verify:oracle` plus Crabbox macOS, Ubuntu, and Windows native `platform-build` and `real-extension` suites
- Pi 0.79.0 platform artifacts: `.artifacts/platform-smoke/run-1780938522145-50q2f2` (macOS platform-build), `.artifacts/platform-smoke/run-1780938572090-bi87g5` (macOS real-extension), `.artifacts/platform-smoke/run-1780938542847-quridb` (Ubuntu platform-build), `.artifacts/platform-smoke/run-1780938587248-c8uo4c` (Ubuntu real-extension), `.artifacts/platform-smoke/run-1780938585007-l0xapp` (Windows native platform-build), `.artifacts/platform-smoke/run-1780938820527-c1j8tt` (Windows native real-extension)
- Pi 0.79.0 isolated local-extension model-agent smoke: `.artifacts/real-smoke/run-1780935835596-pfbn5o` passed with `PI_ORACLE_REAL_TEST_MODEL_AGENT=1 npm run smoke:real:source`
- Pi 0.79.0 packed-install smoke: `.artifacts/real-smoke/run-1780935825537-pmna07` passed with `npm run smoke:real:packed`
- expired-auth drill fail path: `a2460bc1-7d89-4041-b67d-39680d310325`
- `/oracle-auth` repair evidence: the per-run `/tmp/pi-oracle-auth-*/oracle-auth.log` bundle path printed by `/oracle-auth`
- expired-auth drill post-repair success: `fa26a2a7-0057-4a21-b3e0-71c1d020facf`
- successful multi-artifact completion: `b6b3599c-6b91-4315-adfa-8a83aa5eda9b`
- repo-owned sanity harness: `npm run sanity:oracle`
- real installed-extension smoke source of truth: `scripts/oracle-real-smoke.mjs`; required release proof runs packed-install mode (`npm run smoke:real:packed`), asserts Pi 0.80.9, and executes `/oracle-status` through Pi's installed-package loader without provider credentials or an external oracle job; optional slower model-agent submission debugging remains behind `PI_ORACLE_REAL_TEST_MODEL_AGENT=1`; source mode (`npm run smoke:real:source`) is inner-loop/debug only
- macOS, Ubuntu, and Windows native package/build/runtime smoke source of truth: [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md); use `npm run verify:oracle` for everyday local iteration, `npm run smoke:platform:doctor` plus a focused target/suite run for platform-sensitive changes, `npm run smoke:platform:all` for doctor-first platform matrix evidence, and `npm run release:check` for the full local-plus-platform release gate
- release gate: `npm run release:check`, also used by `prepublishOnly`, combines static verification, fresh loaded-extension ChatGPT preset proof via `npm run release:proof:chatgpt-presets`, and all required Crabbox platform smokes
