# OMP Oracle architecture

This document is for contributors and implementers who need to understand OMP Oracle's components, job lifecycle, on-disk state, and invariants before changing runtime behavior.

OMP Oracle (`omp-oracle`) is an extension for the Oh My Pi (OMP, command `omp`) and `pi` coding-agent hosts: a host session packs a compressed archive of selected project files, hands it with a prompt to a web provider (ChatGPT or Grok) in a detached worker, writes the answer to a job directory (`${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`), and sends one best-effort wake-up message telling the asking session the job finished.

Three sign-in transports reach a signed-in provider session: the isolated seed profile (default, both providers), the existing-Chrome relay (ChatGPT only), and the managed browser (ChatGPT only). The isolated seed profile and the relay keep no browser parked between jobs; the managed browser's keeper holds its Chrome open until an idle grace expires.

Companion guides: [Documentation index](README.md) · [Operations guide](OPERATIONS.md) · [Security model](SECURITY.md) · [Compatibility matrix](COMPATIBILITY.md) · [Test plan](TEST_PLAN.md) · [Platform smoke gate](PLATFORM_SMOKE.md) · [Release process](RELEASE.md) · [Upstream lineage](UPSTREAM.md)

<a id="goal"></a>
## Goals

OMP Oracle lets users and coding agents consult ChatGPT or Grok through an existing signed-in web subscription instead of an API key, while keeping every run asynchronous, bounded, and durable on disk:

- Accept manual submissions via `/oracle <request>` and `/oracle-followup <job-id> <request>`, model-driven tool calls via `oracle_submit`, and model-free driver calls via `/oracle-run`.
- Upload a mandatory project context archive on every job: `.tar.zst` up to the `250 MiB` upload ceiling for ChatGPT and `.tar.gz` up to `200 MiB` for Grok.
- Execute browser automation in a detached Node worker process so the host session turn returns as soon as admission or queueing is persisted.
- Store job metadata, saved response Markdown, turn-capture provenance, and validated downloads in `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`, and send at most one automatic wake-up when a job reaches a terminal state.
- Require a persisted host session file (`--no-session` and in-memory sessions are refused) so every job has an owning session for its wake-up; legacy jobs recorded without `sessionId` remain readable by `projectId` as manual status-only records and are never rebound to another session.
- Continue existing provider conversations from saved `chatUrl` metadata rather than keeping a browser or tab open between jobs when idle.

<a id="architecture-decision"></a>
## Design decisions

Five invariants govern browser isolation, shared-Chrome attachment, thread continuity, and concurrency across the extension and workers:

- **Default sign-in transport: isolated seed profile.** `/oracle-auth` builds a verified seed profile (`browser.authSeedProfileDir`, or `<authSeedProfileDir>-grok` for Grok). Each job clones that seed into a disposable runtime profile (`runtimeProfileDir`), starts Chrome paired with a unique `agent-browser` CLI/daemon session (`runtimeSessionName`, `<browser.sessionPrefix>-<runtimeId>`, default prefix `"oracle"`), and deletes the clone in teardown.
- **Opt-in shared-Chrome transports: existing-Chrome relay and managed browser.** When `browser.chatGptRelayEndpoint` or `browser.chatGptManagedProfileDir` is set in agent-level config (the user's `oracle.json` under the host agent directory; see [Config files](#config-files)), the worker connects over the Chrome DevTools Protocol (CDP), opens one job-owned pinned tab (`relayTargetId`), and pins every command to that target without activating tabs or stealing window focus.
- **No unpinned automation of a user's browser.** Tab-switching commands that invoke `Page.bringToFront`, global `chrome://downloads` scraping, and `~/Downloads` directory scans are excluded; see [Design lineage](#design-lineage).
- **Metadata-backed thread continuity.** Same-thread follow-ups reopen the saved `chatUrl` under a per-`conversationId` lease instead of parking browsers or tabs between runs.
- **Bounded active and queued capacity.** At most `browser.maxConcurrentJobs` jobs hold active runtime leases at once across distinct conversations; when every runtime slot is busy, additional submissions wait on disk as `queued` jobs without spawning a worker until promoted, bounded by both job count and retained archive bytes.

## Components

All runtime code sits under `extensions/oracle/` and `prompts/`, split between TypeScript host modules (`lib/`), ESM worker scripts (`worker/`), and shared ESM helpers (`shared/`) imported by both layers.

Entry point and dispatch templates:

- `extensions/oracle/index.ts`: extension entry point; loads prompt templates and registers commands, tools, `/oracle-run`, the programmatic bridge, TUI input interceptors, and session poller hooks.
- `prompts/oracle.md` and `prompts/oracle-followup.md`: dispatch instructions injected for `/oracle` and `/oracle-followup`.

Host-side modules under `extensions/oracle/lib/`:

- `config.ts`: `ORACLE_SUBMIT_PRESETS`, `DEFAULT_CONFIG`, agent-level and project `oracle.json` loading, merge, project-key filtering, and validation.
- `trust.ts`: host project-trust check (`isOracleProjectTrusted`).
- `provider-capabilities.ts`: archive format, file extension, `zstd` requirement, and upload ceiling per provider.
- `archive.ts`: archive entry expansion, default exclusions, `tar`/`zstd`/gzip streaming, and adaptive size-probe pruning for whole-repo `.` archives.
- `runtime.ts`: workspace-root resolution, submit prerequisite checks, `agent-browser` version-floor caching, runtime allocation, runtime and conversation leases, and host-side runtime teardown.
- `locks.ts`: typed host-side wrappers around shared state locks and leases.
- `jobs.ts`: `OracleJob` persistence, archive input validation (`resolveArchiveInputs`), worker spawn and termination, stale-job reconciliation, terminal cleanup retries, notification claims, wake-up settlement, and retention pruning.
- `queue.ts`: queued job ordering, queue position lookup, and admission-locked promotion passes.
- `poller.ts`: per-session background poller, batched process-start-time priming, footer readiness updates, and idle-gated wake-up commits.
- `auth.ts`: host-side `/oracle-auth` and `oracle_auth` coordinator for isolated-seed bootstrap and managed-browser sign-in tabs.
- `commands.ts`: `/oracle-auth`, `/oracle-status`, `/oracle-read`, `/oracle-cancel`, and `/oracle-clean` slash-command handlers.
- `run-command.ts`: model-free `/oracle-run` handler with request-shape validation, exclusive dispatch markers, and atomic result files.
- `tools.ts`: `oracle_preflight`, `oracle_auth`, `oracle_submit`, `oracle_read`, and `oracle_cancel` schemas, error classification, queue-pressure gates, and execution.

Detached workers and browser helpers under `extensions/oracle/worker/`:

- `run-job.mjs`: detached job and `--recollect` worker covering transport setup, readiness, model or tool selection, upload, prompt insertion, send acceptance, completion polling, bound capture, artifact downloads, and teardown.
- `auth-bootstrap.mjs`: detached `/oracle-auth` worker for isolated seed profiles covering read-only cookie import, staged verification, atomic swap, and `pi-oracle-auth-*` diagnostics.
- `managed-browser.mjs`: detached keeper process that spawns Chrome on `browser.chatGptManagedProfileDir`, reports `{ endpoint, browserUrl }`, and quits its child Chrome after idle grace.
- `agent-browser-helpers.mjs`: bounded `agent-browser` command runner, per-subcommand timeouts (raising `agent_browser_timeout`), `batch` stdin framing, and `eval` stdout decoding.
- `chatgpt-ui-helpers.mjs`: ChatGPT selectors, model-picker and Power-slider state parsers, Deep Research widget text parser, and `observedSelection` merging.
- `chatgpt-flow-helpers.mjs`: composer attachment counting, `providerSendAccepted`, URL stability tracking, `nextStaleStopState`, and `nextMissingTurnState`.
- `provider-page-signals.mjs`: snapshot and DOM signal filtering, challenge/outage/upload/response-failure matching, and the ChatGPT and Grok job page-state classifiers.
- `auth-flow-helpers.mjs`: `/backend-api/me` login-probe normalization, `classifyChatAuthPage`, and account-chooser candidate labels.
- `auth-cookie-policy.mjs`: allowlist and drop rules for imported ChatGPT and Grok authentication cookies.
- `chromium-cookie-source.mjs`: macOS SQLite `Cookies` snapshot and Keychain AES-CBC decryption (`auth.chromiumKeychain` paired with `auth.chromeCookiePath`).
- `artifact-heuristics.mjs`: accessibility-snapshot entry parser (`ref`, kind, label, value, disabled).
- `response-capture.mjs`: closure-free in-page turn and report capture, CodeMirror/code-block extraction, Deep Research citation resolution, in-page and native CDP download collectors, and artifact format validation.
- `state-locks.mjs`: worker-side lock and lease wrappers over `shared/state-coordination-helpers.mjs`.

Shared host/worker helpers under `extensions/oracle/shared/`:

- `state-path-helpers.mjs`: jobs (`/tmp`) and state (`/tmp/pi-oracle-state`) directory resolution, job-id validation, and POSIX ownership/symlink/mode checks.
- `state-coordination-helpers.mjs`: atomic hashed lock and lease directory creation, metadata publication, incomplete-directory grace windows, and dead-pid lock reclamation.
- `process-helpers.mjs`: process-start-time reads and `2 s` cache (`ps -o lstart=` or PowerShell `Get-Process`), process-tree termination, `AGENT_BROWSER_NO_*` defaults, socket resolution, and session close with sidecar cleanup.
- `agent-browser-version.mjs`: `0.41.2` `agent-browser` version parser and floor assertion.
- `browser-profile-helpers.mjs`: platform Chromium user-data root safety checks, default executable and profile discovery, clone strategy defaults, and `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` environment scrubbing.
- `relay-browser-helpers.mjs`: CDP `/json/version` readiness checks, target creation and closure, and last-tab release to `about:blank`.
- `relay-cdp-client.mjs`: flat-session WebSocket CDP client for `Target.setAutoAttach` child-frame evaluation, `Page.downloadWillBegin`, and `Page.downloadProgress` events.
- `managed-browser-helpers.mjs`: managed-profile canonicalization, `DevToolsActivePort` and `SingletonLock` inspection, `managedBrowserReplaced`, user leases, and keeper launch.
- `job-lifecycle-helpers.mjs`: phase-to-status mapping, bounded `64`-entry lifecycle event log, cleanup retry schedule, notification/wake-up reducers, and the timed-out recollection binding (`timedOutRecollectionBinding`).
- `job-coordination-helpers.mjs`: queue ordering, admission-blocking predicates, and shared queued-job promotion pass.
- `job-observability-helpers.mjs`: status/read text summaries, wake-up notification payloads, and session footer strings.
- `oracle-run-helpers.mjs`: `/oracle-run` argument parser, request-shape validator, and one-line JSON result summarizer.
- `time-helpers.mjs`: `sleep` and ISO timestamp parsing.

<a id="current-extension-surface"></a>
## Extension surface

When the host loads `extensions/oracle/index.ts`, `oracleExtension(pi)` registers all commands, tools, and event hooks once at load time. Session lifecycle uses `session_start` and `session_shutdown` only, with no shims for the removed `session_switch` or `session_fork` events.

Load-time registration and session hooks:

- **Load time (`oracleExtension`).** Reads `prompts/oracle.md` and `prompts/oracle-followup.md`, registers `/oracle-auth`, `/oracle-status`, `/oracle-read`, `/oracle-cancel`, `/oracle-clean`, and `/oracle-run`, registers the five agent tools plus a `tool_result` hook that sets `isError: true` on `details.error`, publishes the programmatic bridge, and attaches `resources_discover`, `before_agent_start`, and `input` handlers.
- **`session_start` (`startPollerForContext`).** In `print` or `json` mode, stops any poller and returns; without a persisted session file, stops any poller and sets the UI footer to `oracle: unavailable`. On a persisted session, loads config, sets initial readiness to `loaded`, runs best-effort startup maintenance (`reconcileStaleOracleJobs` and `pruneTerminalOracleJobs` under a `250 ms` `reconcile` lock timeout, then `promoteQueuedJobs`), starts the poller, and refreshes the status footer.
- **`session_shutdown`.** Stops the session poller and clears its interval timer.

Dispatch interception and prompt templates:

- **Interactive `tui` host mode.** The `input` handler intercepts `/oracle <request>` and `/oracle-followup <job-id> <request>` before prompt-template expansion, consumes the raw event with `{ action: "handled", handled: true }` so neither `pi` nor Oh My Pi submits the typed text twice, re-injects the compact user message for prompt-history recall, and pairs that turn on `before_agent_start` with a hidden custom message (`display: false`) holding the expanded template.
- **Non-interactive host modes (`print`, `json`, `rpc`).** `resources_discover` exposes `prompts/`, and host prompt-template expansion runs the same workflow from `prompts/oracle.md` or `prompts/oracle-followup.md` (with `before_agent_start` ignoring custom wake-up turns that carry no `prompt`).

Tools, programmatic bridge, and host-side boundaries:

- **Command and tool reference.** For full command syntax, tool parameters, error codes, and session footer strings, see [Commands and tools](OPERATIONS.md#commands-and-tools). `oracle_preflight` reports readiness and global capacity (`Capacity: 1/2 active, 0/2 queued (global).`) from live `runtime` leases and `queued` jobs without acquiring locks or sweeping state.
- **GBNF-compatible schemas.** Every registered tool schema avoids `\S` in regular expressions (using `^.*[^ \t\r\n].*$` instead) so hosts that convert JSON schemas into `llama.cpp` GBNF grammars accept them.
- **Programmatic bridge.** `globalThis[Symbol.for("omp.pi-oracle.programmatic.v1")]` freezes `{ version: 1, preflight, submit, read }` bound to the captured tool definitions' `execute` functions.
- **Model-free `/oracle-run` validation (`lib/run-command.ts`).** `/oracle-run <preflight|submit|read> <request.json> <result.json> [<marker.json>]` runs `oracle_preflight`, `oracle_submit`, or `oracle_read` host-side with absolute paths and no model turn. `preflight` rejects `<marker.json>` (`A preflight dispatches nothing and takes no marker.`), `requestShapeError` (`shared/oracle-run-helpers.mjs`) checks JSON keys, and `prepareArguments` normalizes aliases before `execute`.
- **Model-free `/oracle-run` marker and result files.** On `submit` or `read`, an optional `<marker.json>` is created exclusively (`O_EXCL`, mode `0600`) with `{ operation, dispatch_state: "may_have_been_sent", at }` and directory-fsynced right before `execute`. `<result.json>` is written atomically (mode `0600`), a one-line JSON summary is emitted (`stdout` in `print` mode, `oracle-command-output` otherwise), and existing `<result.json>` or `<marker.json>` files are never overwritten.
- **Cross-project job isolation (`readJobForProject`).** Every project's jobs share one jobs root, so `readJobForProject` finds any job directly by id with no index file and throws `OracleJobProjectMismatchError` (`job_wrong_project` in `oracle_read`) unless the caller supplies that owning `projectId`.
- **Scoped project and session operations.** Project-less no-id status listing, `/oracle-cancel`, `/oracle-clean`, follow-ups, and session wake-ups stay scoped to their owning project and session; see [Read a job from another project](OPERATIONS.md#read-a-job-from-another-project).

<a id="high-level-flow"></a>
## Request lifecycle

Every request passes through host-side readiness and archive packing before a detached worker touches a browser.

### `/oracle` dispatch

`/oracle <request>` delegates context selection and submission to the host agent rather than driving a browser from the slash command. `prompts/oracle.md` gives the agent a ten-step required workflow. In summary:

1. Call `oracle_preflight` first, passing `provider: "grok"` when the user asks for Grok (or `followUpJobId` on `/oracle-followup`, or `chatGptConversationId` when continuing a browser-created ChatGPT thread).
2. Stop and report the blocker if `oracle_preflight` returns `ready: false`; never call `oracle_auth` automatically during `/oracle` preparation.
3. Classify whether the request is narrow or repo-wide, favoring context-rich archives when they fit within the upload ceiling (`250 MiB` for ChatGPT, `200 MiB` for Grok).
4. Include target files plus adjacent tests, docs, configs, and modules for narrow requests, or pass `.` for broad requests (writing a tracked diff file under `.pi/` first when git history matters, because `.git` is excluded by default).
5. Treat a pre-dispatch `oracle_submit` failure with `archive_too_large` as a retryable selection miss: use the size breakdown and `autoPrunedPrefixes` to narrow `files` and retry once, up to two total `oracle_submit` attempts.
6. Call `oracle_submit` and end the turn with a terse dispatch summary so the session returns to idle for the completion wake-up, never polling `oracle_read` in a loop.

### `/oracle-auth`

`/oracle-auth` and `oracle_auth` branch by transport. In relay mode (`browser.chatGptRelayEndpoint`), `oracle_auth` refuses cookie import because sign-in happens directly in the user's Chrome.

On the managed browser (`browser.chatGptManagedProfileDir`), `openManagedBrowserSignIn` acquires a `sign-in` lease, opens `browser.authUrl` in a tab, verifies browser identity (`managedBrowserReplaced`), closes that tab if `/backend-api/me` within `10 s` confirms a signed-in account, or leaves Chrome open for manual sign-in.

On the default isolated seed profile, `worker/auth-bootstrap.mjs` runs under the global `auth` lock:

1. Load config and verify that `browser.authSeedProfileDir` (or `<authSeedProfileDir>-grok` for Grok) is an absolute non-symlink path outside `/`, the home directory, and all known Chromium user-data or cookie-source trees.
2. Read ChatGPT or Grok cookies in read-only mode from the configured local browser cookie store (`30 s` timeout, `PI_ORACLE_AUTH_COOKIE_READ_TIMEOUT_MS`) without launching or mutating the source browser, and filter them through `auth-cookie-policy.mjs`.
3. Sweep stale `.staging-*` directories older than `24 hours` when no `<browser.sessionPrefix>-auth` browser session is listed, and create a fresh `.staging-*` directory next to `browser.authSeedProfileDir`.
4. Close any listed `<browser.sessionPrefix>-auth` session (`10 s` close timeout) and wait until `session list` stops listing it, then launch a headed isolated browser with a dedicated auth `--session` and the staged `--profile`, clear its cookies, and import the filtered provider cookies (`30 s` command timeout).
5. Open the provider URL and poll the auth page-state classifier (`auth.pollMs`, default `1000 ms`, up to `auth.bootstrapTimeoutMs`, default `600000 ms`) until `authenticated_and_ready`.
6. On success, close the staged browser so Chrome flushes state, swap the staged directory into `browser.authSeedProfileDir` (retaining `*.prev` for rollback), and write a non-empty `.oracle-seed-generation` marker (mode `0600`).
7. On `challenge_blocking`, leave the headed staged browser open so the operator can solve the challenge there and rerun `/oracle-auth`.

Each `auth-bootstrap.mjs` run creates a `0700` `pi-oracle-auth-*` directory under the system temporary directory (`os.tmpdir()`) and prints that path; use the printed path to inspect `oracle-auth.log` plus `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, `oracle-auth.body.txt`, and `oracle-auth.png` when diagnostics were captured.

### `oracle_submit`

ChatGPT submissions select a preset from `ORACLE_SUBMIT_PRESETS` (`extensions/oracle/lib/config.ts`), defaulting to `pro_extended`, where `deep_research` sets `selection.tool: "deep_research"` to enable a composer tool instead of a model-picker tier.

Human-readable preset labels and separator variants normalize to canonical preset ids (`invalid_preset` on mismatch), and `preset` is the sole ChatGPT model-selection parameter (`modelFamily`, `effort`, and `autoSwitchToThinking` are internal `selection` snapshot fields, not tool inputs). Grok submissions accept `mode: "heavy"` only and reject `preset`.

`oracle_submit` runs in archive-before-admission order (`extensions/oracle/lib/tools.ts`):

1. Load agent-level and trusted project config (`loadOracleConfig`), require a persisted session file (`persisted_session_required`), and derive `projectId` and `sessionId`.
2. Resolve optional thread targeting (`resolveConversationTarget`): `followUpJobId` into a completed same-project job's `chatUrl` and `conversationId`, or `chatGptConversationId` into `https://chatgpt.com/c/<id>` (combining both raises `oracle_thread_target_conflict`).
3. Resolve the provider, normalize `preset` or `mode` into the `selection` snapshot, and build the provider-specific config (`resolveOracleConfigForProvider`).
4. Validate `files` inside the project root (`resolveArchiveInputs`) before checking local runtime prerequisites: reject missing paths (`archive_input_missing`), paths resolving outside the project (`archive_input_outside_project`), symlinks whose real path escapes the project (`archive_input_symlink_escape`), and a whole-repo `.` when the project root is the home directory, a directory above it, or the filesystem root (`archive_input_too_broad`).
5. Verify submit prerequisites (`assertOracleSubmitPrerequisites`): relay `/json/version` reachability, managed-profile availability and browser executable, or isolated seed readiness (`.oracle-seed-generation`), plus required binaries (`agent-browser` `0.41.2` or newer, `tar`, `zstd` for ChatGPT, `cp` on macOS `apfs-clone`) and writable directories.
6. Under the global `reconcile` lock (skipping on lock timeout), reconcile stale jobs and prune expired terminal jobs.
7. Allocate a unique runtime (`runtimeId`, `runtimeSessionName`, `runtimeProfileDir`).
8. Build the archive (`createArchive`, `120 s` timeout) in `os.tmpdir()`, applying default exclusions (paths skipped when expanding `.` or a directory, `.pi` and `.omp` among them) while keeping explicitly named paths as named (see [What leaves the machine](SECURITY.md#what-leaves-the-machine)). Whole-repo `.` archives prune the largest `build`, `dist`, `out`, `coverage`, `htmlcov`, `tmp`, `temp`, and `.tmp` directories outside `src`, `source`, `sources`, and `lib`.
9. Acquire the global `admission` lock and promote any older `queued` jobs whose runtime and conversation leases are free (`promoteQueuedJobsWithinAdmissionLock`).
10. Attempt to acquire a `runtime` lease (`tryAcquireRuntimeLease`, up to `browser.maxConcurrentJobs` active leases):
    - **Free runtime slot, busy target conversation:** when `target.conversationId` is set, call `tryAcquireConversationLease`; if another active job holds that thread, release the `runtime` lease and refuse immediately (`Oracle conversation <id> is already in use by job <id>. Concurrent jobs targeting the same ChatGPT thread are not allowed.`), never queueing.
    - **Free runtime slot, acquired or fresh conversation:** create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` as `submitted`, move the archive in, and spawn `worker/run-job.mjs` (fresh threads acquire no `conversation` lease during URL binding; `conversation` leases are acquired only at admission, queue promotion, or `--recollect`).
    - **No free runtime slot:** enforce both global queue caps (`browser.maxConcurrentJobs` queued jobs and `browser.maxConcurrentJobs` × `250 MiB` of retained pre-submit archives) without checking `conversation` leases yet, create the job directory as `queued`, move the archive in, and return without spawning a worker.

### Archive size probes

`lib/archive.ts` builds an archive once at the normal compression level (`zstd -19` for ChatGPT, gzip level `9` for Grok, `120 s` command timeout) when it fits under the provider ceiling. When a whole-repo `.` archive exceeds the ceiling, entry sizes are measured once and candidate generated-output directories keep their largest-first order; any non-`.` oversize selection fails immediately without pruning.

During whole-repo pruning, fast probes (`zstd -3`, gzip level `1`) write beside the temporary file list, never over the final archive. The initial exact-to-probe byte ratio estimates pruned sizes; an estimate within `10%` above the ceiling (`BOUNDARY_SLACK = 0.10`) triggers an exact normal-level build that recalibrates the ratio.

The accepted archive must fit at normal compression, and a ratio shift exceeding `10%` in one step can over-prune. Oversize errors report exact bytes alongside `initialArchiveBytes` and the ordered `autoPrunedPrefixes`.

### Worker run flow

For each `submitted` job, `extensions/oracle/worker/run-job.mjs` advances through nine stages:

1. **Prepare transport (`cloning_runtime`, `launching_browser`).** Verify `agent-browser` `0.41.2` or newer (`agent_browser_unsupported` on failure, with `promptSendState: "not_sent"`):
   - **Isolated seed profile:** clone `browser.authSeedProfileDir` into `runtimeProfileDir` under the `auth` lock (`10 minutes` lock wait, `120 s` copy timeout, `10 s` heartbeats), launch Chrome (`headless` by default, `15 s` wait for `DevToolsActivePort`), and connect `agent-browser` (`runtimeSessionName`, `30 s` `connect` timeout).
   - **Shared Chrome:** attach over CDP (`60 s` lock wait and `20 s` launch timeout when managed), verify browser identity (`browserUrl`) if managed, open one new tab, persist `relayTargetId`, and pin every command to that tab.
2. **Open target URL.** Navigate to the saved `chatUrl` (follow-up or normalized `chatGptConversationId` URL) or `browser.chatUrl` (`90 s` `open` timeout).
3. **Verify page readiness (`verifying_auth`).** Poll `waitForOracleReady` (up to `120 s` on ChatGPT, capped by `auth.bootstrapTimeoutMs`, and `30 s` on Grok):
   - Fail immediately on `login_required`, and on `auth_transitioning` or `challenge_blocking` when attached to the existing-Chrome relay.
   - On the isolated seed profile and managed browser, `auth_transitioning` and `challenge_blocking` each wait up to `15 s` (reloading once after `5 s`) before capturing worker readiness diagnostics (`preflight-auth-transition` or `preflight-challenge` under `logs/`) and failing; `transient_outage_error` reloads once on every transport.
4. **Configure model or tool (`configuring_model`).** Dismiss any modal announcement (`Close dialog`) or `Pro feedback` dialog, then record UI provenance in `observedSelection`:
   - **Model presets:** ChatGPT opens the picker (`45 s` timeout), selects the family and steps the Power slider (reopening up to twice if closed mid-step), and waits up to `20 s` to close and settle; Grok selects `Heavy`.
   - **Deep Research (`preset: "deep_research"`, `selection.tool: "deep_research"`):** skip the picker, insert the prompt in `configuring_model`, poll on Node timers up to `10 s` until `Add files and more` is stationary and uncovered, enable Deep Research, and verify its composer pill (`deep_research_toggle_not_found` on failure).
5. **Upload and send (`uploading_archive`).** Upload the archive and confirm delivery before advancing `promptSendState`:
   - Upload `context-<id>.tar.zst` or `.tar.gz`, confirm two `1 s` polls showing the attached file (`10 minutes` on ChatGPT via `waitForUploadConfirmed`, `5 minutes` on Grok), delete the local archive (`archiveDeletedAfterUpload: true`), fill the prompt if not filled in step 4, and arm `Target.setAutoAttach` on `relayTargetId` for `deep_research` (`deep_research_report_unreadable` without shared Chrome).
   - Wait up to `5 minutes` (`waitForSendReady`) for send to enable, set `promptSendState: "attempted"`, and activate send (reverting to `"not_sent"` if DOM click fails); poll `providerSendAccepted` up to `20 s` (`waitForSendAccepted`) to set `"accepted"` once `conversationId` changes, `assistantCount` grows, or `stopStreaming` turns `true`, then sleep `15 s` (`POST_SEND_SETTLE_MS`).
6. **Bind conversation URL (`awaiting_response`).** On ChatGPT, poll up to `60 s` (`waitForStableChatUrl`) for two consecutive reads of a conversation URL whose simultaneous evaluation shows `archiveTurnCount === 1` (`context-<id>.tar.zst` in one user turn), adopting an unverified URL with a log warning after `60 s`. On Grok, adopt the normalized post-send URL without an archive-turn check, and when `conversationId` is absent from that URL, run the `60 s` stability wait after completion.
7. **Await completion.** Poll every `worker.pollMs` (default `5000 ms`) up to `worker.completionTimeoutMs` (default `5400000 ms`, `90 minutes`):
   - On ChatGPT, read the conversation URL, assistant turns, and stop control in one evaluation, requiring two consecutive polls with the same non-empty completion signature (`stableCount >= 2`) for the reply at `baselineAssistantCount`; if another client moved the tab to a different conversation, log one `navigation` event, reopen `job.chatUrl`, and reset `stableCount`.
   - On `deep_research`, once the assistant turn stabilizes, verify that research started (`deep_research_clarification_requested` if the assistant replied instead), wait up to `60 s` (`DEEP_RESEARCH_FRAME_WAIT_MS`) for the widget frame to attach over CDP, and poll `frames[0].document.body.innerText` until `Research completed in` appears (`deep_research_report_unreadable` if frame capture was unarmed, the frame never attaches, or the report times out).
8. **Bind and collect (`extracting_response`, `downloading_artifacts`).** Record `generationStatus: "completed"`, initialize `collectionBinding` (`{ conversationId, responseIndex }`, enriched during [Collection](#collection) with `messageId`, `turnSha256`, and `frameId`), and write `response.md`, `response.capture.json`, raw evidence files, `observedTurn`, and validated `artifacts/`, finishing in `complete` or `complete_with_artifact_errors`.
9. **Teardown.** In `finally`, close the isolated browser (`10 s` close timeout) and delete `runtimeProfileDir`—or close the pinned tab on shared Chrome and release any `managed-browser-user` lease—release `runtime` and `conversation` leases, update `cleanupPending` / `cleanupWarnings`, and when teardown left zero warnings, promote eligible `queued` jobs under the `admission` lock.

### Driver execution and prompt insertion

`worker/agent-browser-helpers.mjs` and `shared/process-helpers.mjs` wrap every `agent-browser` call in deterministic timeouts, clean environments, verified prompt insertion, and sidecar cleanup:

- **Command timeouts.** Commands default to `60 s` (`PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS`, clamped to 5–150 s), with `90 s` for `open`, `30 s` for `connect`, `120 s` for `batch`, and `15 s` for `agent-browser --json stream status` and failure `diagnostics`. Artifact capture uses `90 s` (native CDP or `agent-browser download`) and `105 s` (in-page `captureDownload` eval) with `10 s` heartbeats.
- **Timeout and check discipline.** A timed-out command raises `agent_browser_timeout` and is never replayed. `assertManagedBrowserUnchanged` runs before every command including failure diagnostics, `stream status` runs only after a failed command to detect a dropped browser WebSocket (`connected === false`), and numeric UI waits use Node `sleep()`.
- **Driver environment.** Both workers (`run-job.mjs` and `auth-bootstrap.mjs`) and host session helpers set `AGENT_BROWSER_NO_WEBMCP=1` and `AGENT_BROWSER_NO_VERSION_CHECK=1`; host helpers pass a copied environment without mutating `process.env`. The second variable suppresses the driver's background Chrome release/CVE fetch and version warning.
- **Why WebMCP is off.** From `0.36` the driver otherwise enables WebMCP in the Chrome it launches and appends page-provided tool announcements to the text output of `eval`, `get url`, `snapshot`, and `get text`, which the workers parse; Oracle uses no page tools.
- **`eval` output decoding.** `parseEvalResult` decodes `eval` stdout identically in both workers, turning the bare `undefined` token emitted by `agent-browser` `0.41.2` into JavaScript `undefined` and `null` (or JSON strings) via `JSON.parse`.
- **Prompt clearing and `batch` insertion.** On ChatGPT, `setComposerText` waits up to `15 s` for a visible hydrated `contenteditable` editor, clears any restored draft with `selectAll` and `delete`, verifies the editor is empty, snapshots a fresh textbox ref, and runs one `agent-browser batch` command with `[ ["fill", ref, text] ]` on stdin.
- **Post-insertion digest proof.** Immediately after `batch`, `setComposerText` compares NFC- and whitespace-normalized character length and SHA-256 between Node and the hydrated editor, throwing before send on any mismatch with no `eval` fallback (`deep_research` fills before opening `Add files and more`; Grok inserts text via stdin `eval`).
- **Session close verification.** `closeAgentBrowserSession` checks `agent-browser session list` (`5 s` timeout; an unreadable inventory throws rather than assuming absence), runs `close` (`10 s` timeout) only when listed, and polls `session list` every 50 ms until unlisted so later commands never hit a dying daemon.
- **Sidecar removal.** Once confirmed unlisted (including an already-absent session), `removeAgentBrowserSessionSidecars` deletes `<sessionName>.config` and `<sessionName>.target`; failed inventories or closes never delete sidecars.
- **Driver socket resolution.** Socket paths check `AGENT_BROWSER_SOCKET_DIR`, then `XDG_RUNTIME_DIR/agent-browser` on every platform, then `~/.agent-browser`, then the system temp directory's `agent-browser`, with sanitized `AGENT_BROWSER_NAMESPACE` appending `namespaces/<namespace>/run`.

## Transports

Every job reaches its provider through one of three sign-in transports configured at the agent level; setup recipes belong to [Set up a transport](OPERATIONS.md#set-up-a-transport) and credential boundaries to [Provider credentials](SECURITY.md#provider-credentials).

<a id="persistence-model"></a>
### Isolated seed profile

The default sign-in transport separates long-lived provider authentication from per-job browser state:

- **Auth seed profile (`browser.authSeedProfileDir`).** Passed via `--profile` during `/oracle-auth` to persist cookies, `localStorage`, `IndexedDB`, service workers, and session storage (Grok uses `<authSeedProfileDir>-grok`). Updates build in a sibling `.staging-*` directory, verify live readiness, swap in atomically with `*.prev` retained for rollback, and write `.oracle-seed-generation` (mode `0600`).
- **Per-job runtime profile (`runtimeProfileDir`).** Cloned from the verified seed under the `auth` lock, stripped of `SingletonLock`, `SingletonSocket`, `SingletonCookie`, and `DevToolsActivePort`, launched with `--remote-debugging-port=0` and `--remote-allow-origins=*` (`--headless=new` unless `browser.runMode` is `"headed"`), connected via `--session <runtimeSessionName>`, and deleted in `finally`. `--session-name` and `state save/load` are omitted because they share storage across workers.
- **Seed readiness invariant.** On the isolated seed profile, both `oracle_preflight` and `oracle_submit` reject a missing, unreadable, non-directory, unsafe, or marker-less seed directory before creating any archive or job directory.

### Existing-Chrome relay transport

Setting `browser.chatGptRelayEndpoint` (for example `http://127.0.0.1:9224`) in agent-level config routes ChatGPT jobs through an already signed-in Chrome over a CDP relay—or directly over native loopback CDP on a dedicated persistent user-data directory—without copying cookies.

On native CDP, account isolation comes from Chrome's separate profile directory rather than an account switcher, and the worker neither owns that Chrome process nor checks an email identity; Grok stays on its isolated seed profile. Setup recipes are in [Existing-Chrome relay](OPERATIONS.md#existing-chrome-relay-chatgpt-only) and [Dedicated account in persistent Chrome](OPERATIONS.md#dedicated-account-in-persistent-chrome).

Design invariants:

- **Target discovery and pinned tabs.** The endpoint must serve `/json/version` with `webSocketDebuggerUrl` (`5 s` timeout; `relay_unavailable` otherwise) and support CDP `Target.getTargets`, target creation, attachment, and closure (`agent-browser` `0.41.2` or newer). Each job opens one tab, persists `relayTargetId` in `job.json`, and passes `--cdp <endpoint> --pin-tab`.
- **Pinned-tab teardown.** Cleanup verifies ownership, closes `relayTargetId` (or navigates it to `about:blank` when Chrome refuses `Cannot close the last tab`, which the managed-browser keeper counts as idle), confirms removal, and disconnects; relay mode never deletes a profile directory.
- **Hidden-tab stream reconciliation.** Because the worker never activates its tab, Chrome marks background or occluded tabs `hidden`, stopping `requestAnimationFrame` and throttling timers to `1 Hz` while ChatGPT's network-driven stop control clears independently. `reconcileStreamedTurn` treats streamed DOM text as a lower bound, reloads `job.chatUrl`, and polls up to `45 s` (`RELOAD_RECONCILE_TIMEOUT_MS`, every `1 s`) for two identical non-empty reads.
- **Background throttling flags.** Launch flags (`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`) keep an occluded window's active tab `visible`, while background tabs and minimized windows continue to throttle, so reload reconciliation runs unconditionally.
- **Stale stop-control recovery.** On non-Deep-Research ChatGPT conversations, when the stop control outlives a finished stream and non-empty text at the target reply index stays unchanged for `2 minutes` (`120000 ms`, `STALE_STOP_CONTROL_MS`), `nextStaleStopState` reloads `job.chatUrl` to re-read generation state (empty text never ages, preserving long thinking phases).
- **Missing-turn reload.** On non-Deep-Research ChatGPT conversations, when neither a completion signature nor an active stop control appears for `5 minutes` (`300000 ms`, `MISSING_TURN_RELOAD_MS`), `nextMissingTurnState` and `nextMissingTurnReloadState` reload `job.chatUrl` at most once per job (`MISSING_TURN_RELOAD_MAX = 1`) to recover a finished turn that never rendered live; Deep Research is exempt from both reloads because it reads the widget frame.
- **Cross-client navigation guard.** Another CDP client or user attached to the same Chrome can navigate the job's tab. Every poll, URL adoption, completion-failure `Retry` button check, and bound capture reads the page's conversation identity in the same browser evaluation as the DOM state and reopens `job.chatUrl` if the tab moved elsewhere.
- **Follow-ups and auth.** Follow-ups open a new pinned tab on the saved `chatUrl`; a missing or mismatched target fails closed. `oracle_preflight` checks `/json/version` reachability only; the worker verifies login before upload, and `oracle_auth` refuses cookie import in relay mode.

### Managed browser transport

Setting `browser.chatGptManagedProfileDir` (agent-level, ChatGPT only, mutually exclusive with `browser.chatGptRelayEndpoint` and separate from seed and runtime directories) points Oracle at a dedicated Chrome user-data directory. Jobs use the [Existing-Chrome relay transport](#existing-chrome-relay-transport) pinned-tab path while Oracle manages Chrome and checks its browser identity; see [Managed ChatGPT browser](OPERATIONS.md#managed-chatgpt-browser-dedicated-account).

- **Profile attach.** Under the `managed-browser` lock (`60 s` timeout) keyed on the canonicalized profile path, `acquireManagedBrowser` writes a `managed-browser-user` lease and inspects the profile: a running Chrome matching `DevToolsActivePort` is reused, a stopped profile launches Chrome under the keeper (`20 s` timeout), and a profile held without a matching endpoint (`SingletonLock` `<host>-<pid>` plus start time) fails with `managed_browser_in_use`.
- **Persisted `managedBrowser` record.** Once attached, `job.json` persists `managedBrowser` as `{ endpoint, browserUrl }`, where `browserUrl` is Chrome's `/json/version` `webSocketDebuggerUrl` (there is no `browserId`, `profileDir`, or `pid` field). Worker teardown, `/oracle-cancel`, and stale-job cleanup act on that browser instance, and a tab whose browser has exited counts as closed.
- **Endpoint and browser-identity proof.** Managed Chrome launches with `--remote-debugging-address=127.0.0.1` and `--remote-debugging-port=0`, writing `DevToolsActivePort` on startup and leaving it behind on exit. The worker checks that live `/json/version` `webSocketDebuggerUrl` equals `browserUrl` before opening the tab, during readiness polling, and before every command including diagnostics (`/oracle-auth` checks browser identity before trusting sign-in).
- **Sticky replacement failure.** If a different browser answers on `endpoint`, the verdict is sticky and the job fails with `managed_browser_changed` rather than letting a reconnecting `agent-browser` daemon open a tab in the replacement browser (at most one command already in flight across a port reuse can leave a blank tab before the next check halts the worker).
- **Keeper (`extensions/oracle/worker/managed-browser.mjs`).** Spawns Chrome as a child process, reports `{ endpoint, browserUrl }` in a one-line stdout handshake, logs to `managed-browser.log` (mode `0600`) in the state directory, and sends `SIGTERM` (then `SIGKILL` after `15 s`) once no live `managed-browser-user` lease and no non-blank page remain for `2 minutes` (`120000 ms`, `PI_ORACLE_MANAGED_BROWSER_IDLE_MS`, re-checked under the `managed-browser` lock).
- **Keeper process ownership.** The keeper never signals a Chrome it did not spawn; `SIGTERM` or `SIGINT` to the keeper quits its child Chrome, whereas if the keeper crashes or receives `SIGKILL`, Chrome stays up and later jobs reuse it without auto-quitting.
- **Sign-in and readiness.** `/oracle-auth` opens `browser.authUrl` under a `sign-in` lease, closing that tab if `/backend-api/me` within `10 s` confirms a signed-in account or leaving it open until the user closes it. `oracle_preflight` and the poller inspect the profile path, executable, and `SingletonLock` holder without launching Chrome, so a stopped managed browser reports `ready` (on macOS, Chrome activates once on first window creation only).

## State on disk

Oracle coordinates host sessions and detached workers entirely through private files on disk: two configuration files, a shared lock-and-lease directory, and one directory per job.

### Config files

`loadOracleConfig` (`extensions/oracle/lib/config.ts`) deep-merges `DEFAULT_CONFIG` with two optional JSON files, where trusted project settings override agent-level settings on allowed keys:

1. Agent-level config: `~/.omp/agent/extensions/oracle.json` (Oh My Pi) or `~/.pi/agent/extensions/oracle.json` (`pi`).
2. Project config: `.omp/extensions/oracle.json` (Oh My Pi) or `.pi/extensions/oracle.json` (`pi`).

Scope, trust, and import invariants:

- **Project trust (`lib/trust.ts`, `lib/config.ts`).** Every runtime entry point with a session context queries `ctx.isProjectTrusted?.() ?? true`; a host without that method counts the project as trusted, and an untrusted project has its project config file skipped whole. Code that loads config without a session context honors CLI `--approve`/`-a` and `--no-approve`/`-na` first, then `pi`'s `ProjectTrustStore`, and loads no project file when the host has no trust store.
- **Privileged keys are agent-level only.** A trusted project file may set only `defaults`, `worker`, `poller`, `artifacts`, and `cleanup`. Any other top-level key—including `browser` or `auth`—throws `Invalid oracle project config: <key> cannot be overridden at the project level` (`oracle_config_invalid` in tools) rather than being ignored, because `browser` and `auth` control local executables, profile paths, CDP endpoints, and credential sources.
- **Presets and safe paths.** `defaults.preset` and submit-time `preset` validate against `ORACLE_SUBMIT_PRESETS`. Profile directories (`browser.authSeedProfileDir`, `browser.runtimeProfilesDir`, `browser.chatGptManagedProfileDir`) must be distinct absolute paths outside `/`, the home directory, and known Chromium user-data or cookie-source trees (`oracle_profile_path_unsafe`).
- **Profile clone strategy.** `browser.cloneStrategy` defaults to `apfs-clone` on macOS (`cp -cR`, overridable via `PI_ORACLE_CP_PATH`) and `copy` on Linux and Windows (Node recursive copy).
- **Cookie import path.** Default `/oracle-auth` extraction reads `@steipete/sweet-cookie`'s Chrome/Chromium backend, or—on macOS when `auth.chromiumKeychain` and `auth.chromeCookiePath` are paired (partial config is rejected, and `auth.chromiumKeychain` is macOS-only)—snapshots the SQLite `Cookies` store (`worker/chromium-cookie-source.mjs`), decrypts AES-CBC values via Keychain, and filters cookies via `worker/auth-cookie-policy.mjs`.
- **Secret environment scrubbing.** Every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable is scrubbed from child environments before browser, helper, or archive subprocesses spawn. For cookie backends, Linux keyring variables, macOS Keychain fields, and every config key, see [Cookie sources](OPERATIONS.md#cookie-sources) and [Configuration reference](OPERATIONS.md#configuration-reference).

### Shared state directory

Cross-process locks, leases, and the managed-browser keeper log (`managed-browser.log`, mode `0600`) sit under `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}` (`shared/state-path-helpers.mjs`, `shared/state-coordination-helpers.mjs`). Before touching the directory, `assertTrustedOracleStateRoot` verifies on POSIX that the root is neither a symlink nor owned by another uid.

Each lock or lease is an atomic `0700` directory at `<stateDir>/locks/<kind>-<sha256_24>/` or `<stateDir>/leases/<kind>-<sha256_24>/` holding `metadata.json` (file mode `0600`), where `<sha256_24>` is the first 24 hex characters of SHA-256 over `key`.

Creation stages a `.tmp-*` directory with `metadata.json` and renames it into place; a published directory missing valid `metadata.json` becomes reclaimable after `1000 ms` (`ORACLE_METADATA_WRITE_GRACE_MS`), an abandoned `.tmp-*` directory after `60000 ms` (`ORACLE_TMP_STATE_DIR_GRACE_MS`), and any lock whose `processPid` is dead is reclaimed on contention or during `sweepStaleLocks`.

| Lock kind | Key | Wait timeout | Protects |
|---|---|---|---|
| `admission` | `global` | `30 s` (`50 ms` on poller) | Runtime and conversation lease acquisition, queue caps, job creation, promotion, and cancellation |
| `auth` | `global` | `10 minutes` | `/oracle-auth` seed staging/swap and per-job seed-to-runtime profile cloning |
| `reconcile` | `global` | `30 s` (`50 ms` poller, `250 ms` startup) | Stale-job reconciliation and terminal-job retention pruning |
| `job` | `<jobId>` | `10 s` | Atomic `job.json` read-modify-write mutations across host and worker processes |
| `recollect` | `<jobId>` | `30 s` | Exclusive `--recollect` execution for one job |
| `managed-browser` | `<canonicalProfileDir>` | `60 s` | Managed Chrome inspection, user-lease creation, keeper launch, and idle quit |

| Lease kind | Key | Liveness check | Holds |
|---|---|---|---|
| `runtime` | `<runtimeId>` | `jobBlocksAdmission` on `jobId` (`browser.maxConcurrentJobs` max) | One concurrency slot for an admitted or recollecting worker |
| `conversation` | `<conversationId>` | `jobBlocksAdmission` on `jobId` | Exclusive execution on one provider conversation |
| `wakeup-target` | `<projectId>::<sessionId>::<pid>::<startedAt>` | Live matching pid, updated within `2 minutes` | Eligibility of a persisted host session poller to receive wake-ups |
| `managed-browser-user` | `<owner>:<uuid>` | Live `processPid` (`job:<jobId>` or `sign-in`) | Active attachment that keeps an Oracle-launched Chrome from idle-quitting |

`tryAcquireRuntimeLease` and `tryAcquireConversationLease` (`lib/runtime.ts`) resolve each lease's `jobId` under `PI_ORACLE_JOBS_DIR` via `jobBlocksAdmission` (`shared/job-coordination-helpers.mjs`), keeping the lease while `status` is `preparing`, `submitted`, or `waiting`, `cleanupPending` is `true`, or `workerPid` matches a live process, and reclaiming stale leases automatically.

### Job layout under the configured jobs dir

Each job directory is created at `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with directory mode `0700` and file mode `0600`; on POSIX, `isTrustedOracleJobDir` ignores symlinked, foreign-uid, or group/world-writable job directories and `job.json` files.

```text
${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/
  job.json
  prompt.md
  context-<job-id>.tar.zst             # ChatGPT (deleted once the upload is confirmed)
  context-<job-id>.tar.gz              # Grok (deleted once the upload is confirmed)
  response.md                          # saved response (native Markdown export, exact code block, or derived Markdown)
  response.capture.json                # turn binding, capture method, fidelity, citations, code blocks, gaps, artifact summary
  response.raw.txt                     # bound-turn innerText evidence
  response.raw.html                    # bound-turn sanitized DOM (active content, transient attributes, signed URLs stripped)
  response.block-<n>.txt               # exact text of each code block in the bound turn
  <capture-file>.<sha256>.previous     # prior bytes preserved when overwriting changed capture or artifact files
  artifacts.json                       # discovered, downloaded, validated, and failed artifact records
  artifacts/
    <sha256>-<file name>               # validated downloads only
  logs/
    worker.log
    <reason>.{url.txt,snapshot.txt,body.txt,signals.txt,png}
```

During `agent-browser download` fallback, a transient `artifacts/.download-<candidateId>-<uuid>` file is removed in `finally`. On worker failures, `captureDiagnostics` writes `<reason>.{url.txt,snapshot.txt,body.txt,signals.txt,png}` under `logs/` for reasons `preflight-auth-transition`, `preflight-challenge`, `preflight`, `preflight-timeout`, `send-not-accepted`, and `failure`.

### `job.json` fields

Fields in `OracleJob` (`extensions/oracle/lib/jobs.ts`), grouped by responsibility:

- **Identity and status:** `id`, `status` (`queued | preparing | submitted | waiting | complete | failed | cancelled`; `preparing` is included in `ACTIVE_ORACLE_JOB_STATUSES` and `jobBlocksAdmission`, while `PHASE_STATUS` maps no phase to it), `phase` (`queued | submitted | cloning_runtime | launching_browser | verifying_auth | configuring_model | uploading_archive | awaiting_response | extracting_response | downloading_artifacts | complete | complete_with_artifact_errors | failed | cancelled`).
- **Lifecycle timestamps and events:** `phaseAt`, `createdAt`, `queuedAt`, `submittedAt`, `completedAt`, `heartbeatAt`, `cancelRequestedAt`, `cancelReason`, `lifecycleEvents` (capped at `64` entries).
- **Origin, selection, and config:** `cwd`, `projectId`, `sessionId`, `originSessionFile`, `requestSource` (`command | tool`), `selection` (`{ provider, preset?, mode?, modelFamily, effort?, tool?, autoSwitchToThinking }`), `extensionProvenance` (`{ schemaVersion: 1, packageName, packageVersion, sourcePath, gitHead? }`), `config`.
- **Thread and prompt state:** `followUpToJobId`, `chatUrl`, `conversationId`, `promptPath`, `reasoningPath` (initialized to `reasoning.md` by `createJob`, never written by the worker), `promptSendState` (`not_sent | attempted | accepted`).
- **Observed UI and turn metadata:** `observedSelection` (`{ at, product?, modelLabel?, effortLabel?, effortControls?, deepResearchVerified?, deepResearchIframeTitle? }`), `observedTurn` (`{ at, durationLabel?, durationSeconds? }`, for example `Worked for 15m 7s` or `Research completed in 6m`).
- **Generation and collection:** `responsePath`, `responseFormat` (`text/plain`), `generationStatus` (`completed` once generation finishes, omitted beforehand), `collectionStatus` (`complete | partial | failed`), `collectionRequiredMissing`, `collectionOptionalMissing`, `collectionBinding` (`{ conversationId, responseIndex, messageId?, turnSha256?, frameId? }`), `responseCapturePath`.
- **Recollection state:** `recollectionNeeded`, `recollectionError`, `recollectionCompletionVerifiedAt` (ISO-8601 UTC, written once when a timed-out reply is verified and collected; absent for ordinary completion and already-complete artifact recollection), `recollectionPriorWorker` (`{ runtimeSessionName?, workerPid?, workerStartedAt?, cleanupPending?, cleanupWarnings?, cleanupAttemptCount?, cleanupRetryAt? }`).
- **Archive and artifacts:** `archivePath`, `archiveSha256`, `archiveDeletedAfterUpload`, `artifactPaths`, `artifactsManifestPath`, `artifactFailureCount`.
- **Notification delivery:** `notifiedAt`, `notificationEntryId`, `notificationSessionKey`, `notificationSessionFile`, `wakeupAttemptCount`, `wakeupLastRequestedAt`, `notifyClaimedAt`, `notifyClaimedBy`.
- **Wake-up settlement and observation:** `wakeupSettledAt`, `wakeupSettledSource` (`oracle_read` tool, `oracle_status` for `/oracle-status`, or `oracle_read_command` for `/oracle-read`), `wakeupSettledSessionFile`, `wakeupSettledSessionKey`, `wakeupSettledBeforeFirstAttempt`, `wakeupObservedAt`, `wakeupObservedSource`, `wakeupObservedSessionFile`, `wakeupObservedSessionKey`.
- **Worker, runtime, and transport:** `workerPid`, `workerNonce`, `workerStartedAt`, `logsDir`, `workerLogPath`, `runtimeId`, `runtimeSessionName`, `runtimeProfileDir`, `seedGeneration`, `relayTargetId`, `managedBrowser` (`{ endpoint, browserUrl }`).
- **Errors and cleanup:** `error`, `errorCode`, `cleanupPending`, `cleanupAttemptCount`, `cleanupRetryAt`, `cleanupWarnings`, `lastCleanupAt`.

Legacy jobs written before collection binding or session-file provenance existed remain readable: missing `collectionStatus` is treated as unknown rather than failed, and jobs without `sessionId` stay inspectable by `projectId` without wake-up rebinding.

`observedSelection` is optional (including on legacy and Grok jobs) and records UI provenance without storing page text, cookies, or secrets:

- **Fields and slider reads.** `at` holds the latest observation timestamp, `modelLabel` holds the model-selector DOM text (or a supported compact opener's snapshot label, clearing stale model/product provenance when unreadable), and `effortLabel` holds the observed Power slider stop (`<Label> (<index> of <count>)`, the bare target label when the picker closed onto the selection while stepping, or `null`).
- **Passive post-configuration re-read.** After model configuration, each ChatGPT job re-reads the mounted Power control without opening its menu, focusing the slider, or inferring an offered stop count from requested settings or an earlier step.
- **Absent vs unavailable controls.** An unmounted Power control—including on `deep_research` jobs or when a retained menu is contradicted by a collapsed opener—sets `effortLabel: null` and `effortControls: "absent"`; a mounted control whose description cannot be read or parsed sets `effortLabel: null` and `effortControls: "unavailable"` without blocking submission.
- **Lowercase `product` classification.** `mergeObservedSelection` (`worker/chatgpt-ui-helpers.mjs`) prefers a readable slider stop over a generic picker caption and sets `product` to `"pro"`, `"thinking"`, `"instant"`, or (when `deepResearchVerified` or `deepResearchIframeTitle` is present) `"deep_research"`; unrecognized labels leave `product` unset rather than copying `selection.preset`.
- **Immediate atomic merges.** Slider readings merge under the per-job `job` lock as soon as they are observed so a failure mid-configuration preserves earlier readings, and `deepResearchIframeTitle` (`Deep research`) is merged from the bound iframe's `DOM.describeNode` attributes during frame binding.

### Response format

`responseFormat` in `job.json` is `"text/plain"`. The file path is `response.md` across all job layouts; its contents are normalized UTF-8 plain text or Markdown (from native Markdown export, an exact single `markdown` code block, or derived DOM Markdown) for agent and user consumption.

## ChatGPT page-state classifier

Before configuring the composer or uploading, the ChatGPT worker classifies the page from its URL, accessibility snapshot, filtered page signals, and `/backend-api/me` probe (`worker/provider-page-signals.mjs`, `worker/auth-flow-helpers.mjs`, and `worker/chatgpt-ui-helpers.mjs`), evaluating states in this order:

1. **Settling challenge (`unknown`).** Matches challenge-settling text (`Verification successful` or `Waiting for chatgpt.com to respond`) alongside challenge markers, returning `unknown` so the poller waits.
2. **Challenge blocking (`challenge_blocking`).** Matches human-verification markers (`Just a moment`, `Verify you are human`, `Cloudflare`, CAPTCHA/Turnstile/hCaptcha prompts, or unusual/suspicious-activity blocks). During `/oracle-auth`, `classifyChatAuthPage` next checks filtered signal text for HTTP `431` (`Request Header Or Cookie Too Large`) and returns `login_required`.
3. **Transient outage (`transient_outage_error`).** Matches provider outage or rate-limit banners (`Too many requests`, `rate limit`, `Try again later`, `Something went wrong`, `A network error occurred`, websocket error text, or `network error`).
4. **Login required (`login_required`, session or shell).** Matches `/backend-api/me` returning an anonymous `ua-*` id alongside an auth path (`/auth/*`, `auth.openai.com`, `/login`, `/signin`, `/log-in`) or a visible login control (`hasLoginCta` matches `Log in`, `Login`, `Sign in`, `Signin`, or `Continue with`); `/backend-api/me` status `401`; or an auth path or `domLoginCta` shell lacking non-anonymous `id`/`email` identity.
5. **Auth transitioning (`auth_transitioning`).** Matches an auth path where `/backend-api/me` returned non-anonymous account identity, or an allowed ChatGPT origin with a usable composer and `/backend-api/me` status `200` or `403` where `domLoginCta` remains visible alongside that account identity.
6. **Ready (`authenticated_and_ready`).** Requires an allowed ChatGPT origin outside auth paths, an enabled composer textbox (`Ask ChatGPT` or `Chat with ChatGPT`; `Work with ChatGPT` is a separate surface and never counts as ready) plus `Add files and more`, `/backend-api/me` status `200` or `403` (or `ok: true` in `/oracle-auth`), and no visible `domLoginCta`. The model picker is verified during `configuring_model` and is untouched by `deep_research` jobs.
7. **Off-origin redirect (`login_required`) and fallback (`unknown`).** A non-empty URL outside the allowed ChatGPT origins returns `login_required`; all other incomplete pages return `unknown`.

Grok jobs and `/oracle-auth grok` use `classifyGrokPage` and `classifyGrokAuthPage` in `worker/provider-page-signals.mjs`, checking the same challenge and outage patterns, `https://grok.com` login controls, and the `Ask Grok anything` plus `Attach` composer without `/backend-api/me`.

Provider error patterns sit in `worker/provider-page-signals.mjs`, shared by the job and auth classifiers. Snapshot signal filtering drops `textbox`, `searchbox`, `combobox`, `link`, `navigation`, and `complementary` (sidebar) subtrees with their continuation lines so prompt text echoed into the composer or the sidebar's chat title never triggers a false match, while raw snapshots drive login and composer control detection.

The in-page signal expression reads at most `8000 characters` of visible text outside editors, navigation, sidebars, and conversation turns (including `data-turn-key` exchanges), never the document title; failed evaluations contribute no evidence, `.signals.txt` captures diagnostic text on failure, and worker error logs record only the matched pattern.

During completion polling, `detectCompletionFailure` reads page signals lazily, only when `Retry` is visible without a stop control, and includes the bound assistant turn only when its trimmed length is at most `400` characters. Long answers that quote error messages never trigger `Retry`; `Retry` clicks at most once per job and only after re-verifying the job's own conversation.

## Collection

Generation (the provider writing the reply) and collection (saving the reply and its files) are tracked independently. `generationStatus` is set to `"completed"` once generation finishes (and is omitted beforehand); `collectionStatus` records local capture fidelity (`complete` with no gaps, `partial` with named required or optional gaps, or `failed` when no usable response bytes were saved).

Gap codes recorded in `job.json` and `response.capture.json`:

- **Required (`collectionRequiredMissing`):** `response` (no usable `response.md` bytes), `rich_response_fidelity` (`fidelity` is `"text_only"`), `bound_response_capture` (bound capture threw), `redacted_transport_links` (signed links stripped from `response.md`), `unresolved_source_links` (unresolved citation, `[n]` pill, or source), `native_export_source_links` (DOM source URL absent from Deep Research Markdown), and `diagram_source:<count>` (diagrams lacking Mermaid source).
- **Optional (`collectionOptionalMissing`):** `native_markdown_export` (no validated Deep Research Markdown download), `research_widget_state` (no Markdown in `report_message`), `artifact:<candidate>` (unvalidated artifact candidate), `artifact_inspection:<state>` (`not_performed` when `artifacts.capture` is `false`, or `failed`), and `capture_error:<message>` (redacted exception from bound capture).

### Exact binding

Collection binds to the single assistant turn produced for the job: `conversationId`, `responseIndex` (baseline assistant count at send), the turn's `data-message-id` or `data-chatgpt-selection-message-id` (resolved through heading wrappers), `turnSha256` over normalized text (HTML class attributes churn across renders, so sanitized HTML is not hashed), and `frameId` for Deep Research.

Every capture evaluation checks `location.pathname` against `conversationId` in the same browser call as the DOM read; if the tab moved to another conversation, `acquireBoundTurn` reopens `job.chatUrl` and retries up to `20` times.

Message identity takes precedence over a stale positional index, a positional root spanning multiple message ids is refused on first capture, and missing or ambiguous identity fails closed: on ChatGPT, streamed intermediate text is never written as a fallback `response.md`, `collectionStatus` becomes `failed`, and `recollectionNeeded: true` directs callers to recollect rather than resubmit (Grok has no bound DOM capture and retains its streamed `text_fallback` response).

### Capture

`extensions/oracle/worker/response-capture.mjs` defines closure-free browser functions evaluated directly in the owned page or bound report frame:

- **Scoped DOM extraction.** From the bound root, `captureScopedResponse` extracts raw text, sanitized HTML, derived Markdown, code blocks, stable source URLs (dropping signed transport URLs while inventorying literal URLs in text and code), structural artifact candidates, child frames, and the reasoning-time label (`Worked for ...` or `Research completed in ...`).
- **Code blocks and CodeMirror editors.** A code block is a `pre` or `CodeBlock-…` container: live replies nest `pre`, reloaded conversations render bare block `code`, and runnable blocks such as Python mount a CodeMirror editor whose full document replaces viewport-clipped rows.
- **Fence languages and exact-code mode.** A block's fence language comes from `language-*` or the action-bar label (`YAML` becomes `yaml`) without leaking into prose; a non-Deep-Research turn containing a single `markdown` code block is saved verbatim (`exact_code`), and otherwise derived Markdown (`derived_markdown`) is written.
- **Deep Research cross-origin frame.** Deep Research (`preset: "deep_research"`) renders its report in a cross-origin sandboxed App iframe on `web-sandbox.oaiusercontent.com` (titled `internal://deep-research` in the earlier shell or `Deep research` beside `data-turn-key`) whose same-origin child frame (`frames[0]`) holds the report while the top page holds a placeholder.
- **Shared-Chrome requirement for Deep Research.** Chrome surfaces that iframe as a CDP child session only when `Target.setAutoAttach` was armed on `relayTargetId` before the frame was created, so Deep Research requires shared Chrome and fails on the isolated seed profile with `deep_research_report_unreadable` (alongside `deep_research_toggle_not_found` and `deep_research_clarification_requested`).
- **Deep Research Markdown sources.** Collection prefers Markdown sources (`native_markdown`): first the validated native export (`native_report_download`), then Apps SDK widget state (`frames[0].openai.widgetState.report_message`, `report_widget_state`), converting citation tokens (`U+E200 cite U+E202 <ref> ... U+E201`) into numbered footnotes backed by `content_references` (`unresolved_source_links` when unresolved) while preserving Mermaid and code fences.
- **Rendered iframe DOM fallback.** Only if neither Markdown source is available does collection convert the rendered iframe DOM, dropping status counters, keeping `[n]` pills (`unresolved_source_links`), and counting sourceless diagrams in `diagram_source:<count>`, with token, source, and unresolved counts saved under `citations` in `response.capture.json`.

### Artifacts

Artifact candidates are discovered only inside the bound turn or bound report frame from elements with `download` attributes, file-like `href`s, or export labels, excluding container elements that wrap other controls or exceed `200 characters` of text so the research widget wrapper never masks its `Export` button. Links to external origins without a `download` attribute are citations rather than candidates; visible labels are display metadata, never trusted filenames.

Each candidate is tracked in `artifacts.json` (`discovered`, `downloaded`, `validated`, `failed`), capped at `25 MiB` (`CAPTURE_LIMIT_BYTES` in `response-capture.mjs`), validated against declared size and format (PDF, ZIP including Office XML members for `.docx`, `.xlsx`, and `.pptx`, PNG, or non-null UTF-8 text), and written once to `artifacts/<sha256>-<name>`.

Standard turn artifacts run `captureDownload` (`105 s` timeout) in-realm under temporary `fetch`, `window.open`, and anchor hooks, falling back to `agent-browser download <ref> <dest>` (`90 s` timeout).

For Deep Research **Export → Export to Markdown**, the sandboxed iframe delegates the download to the host page where frame hooks cannot see the bytes. Before clicking export, `collectNativeDownload` (`90 s` timeout) calls `Page.enable` on both the pinned tab session and bound frame session, arms a `URL.createObjectURL` `Blob` registry in each realm, and listens for `Page.downloadWillBegin` and `Page.downloadProgress` from the bound frame tree.

It then reads bytes from the registered `Blob` or `data:` URL (up to `25 MiB`) and verifies Chrome's `totalBytes` and the report title; if `Page.downloadWillBegin` reports an `https:` signed transport URL whose saved disk file relays cannot read, it records an optional `native_markdown_export` gap rather than issuing a separate network fetch.

Because `chrome.debugger` extension relays do not route `Browser.setDownloadBehavior`, the worker never sends it, never alters Chrome's download directory, and never scans `~/Downloads` or `chrome://downloads`.

### Recollection

Recollection repeats collection without touching the composer, clicking Retry, or sending a prompt. `oracle_read({ jobId, action: "recollect", responseIndex?, messageId? })` admits a `complete` job, or a job that timed out waiting for its reply after `promptSendState: "accepted"` (otherwise `Recollection requires a completed job, or one that timed out waiting for its reply after the prompt was accepted.`), and forwards the optional binding arguments to `run-job.mjs --recollect`. The read is synchronous and rereads `job.json` after the worker ends; its result is not a separate completion claim.

The worker runs under the per-job `recollect` lock and the global `admission` lock, and refuses immediately rather than queueing if runtime capacity or the conversation lease is busy.

The worker opens a short `oracle-<uuid>` driver session (sized for macOS's `103-byte` Unix socket path limit), arms CDP frame capture before navigating, reacquires the bound turn, and re-runs collection and export capture:

- **Anchored binding.** A positional-only binding locates the user turn carrying `context-<id>.tar.zst`, verifies its first reply sits at `responseIndex`, and refuses an archive shown in zero or multiple user turns.
- **Timed-out jobs.** A job that failed with `Timed out waiting for ChatGPT response completion` (or Grok) after `promptSendState: "accepted"` is recollected through the same archive anchor (`timedOutRecollectionBinding`, shared by `oracle_read` and the worker): at the reply index the timeout saved, or at an explicit `responseIndex` alone for a job recorded before that index was saved. An explicit index never moves a saved one and `messageId` is refused. Before collection, ordinary replies use `waitForChatCompletion`: generation must be inactive, the bound turn present, and its completion signature identical on two consecutive observations. The archive anchor identifies the exchange; a learned message ID then follows that turn even if later turns shift its position. Without an ID the anchor remains in force; no hash of unfinished text is frozen. A later turn cannot supply the response, and a conversation-wide Stop conservatively delays verification even if it belongs to a later turn. Deep Research keeps its existing report-frame wait.
- **Wait and receipt.** The ordinary-reply wait gets a fresh deadline from the job's saved `worker.completionTimeoutMs` (90 minutes by default), using the same budget as the original completion wait. The tool's subprocess backstop adds the existing ten-minute launch/collection/cleanup allowance to that budget. Deep Research proves completion through the bound widget's `Research completed in …` marker and a non-empty report body before collection and any completion receipt. As a limit, a timed-out Deep Research job is recollected only if its report finishes within the existing 60-second report wait, unlike a chat reply's full completion-timeout wait; still-running, empty, or missing reports leave the original failure intact with no receipt. Throughout the wait, `status`, `phase`, `error`, and `completedAt` retain the original failure. Expiry or interruption leaves that failure intact and records `recollectionError`; a durable in-progress message also explains an abrupt worker death. Successful verification and collection transition to `complete` or `complete_with_artifact_errors` and write `recollectionCompletionVerifiedAt` once, in that transition. Already-complete artifact recollection neither creates nor rewrites this receipt.
- **Legacy binding.** Jobs completed before binding existed require explicit `responseIndex` and `messageId` together, which may add identity to a saved positional index without moving it or replacing a saved exact binding.
- **Attribute drift.** A turn root missing `data-message-id` after markup drift is recollected only when its `turnSha256` matches.
- **Non-destructive preservation.** `preserveCaptureFile` writes `<capture-file>.<sha256>.previous` before overwriting any capture or artifact file with changed bytes. If recollection fails, `recollectionError` is recorded, `bound_response_capture` is marked missing, any `messageId` learned before the failure stays persisted, and existing `response.md` and validated `artifacts/` files remain intact.
- **Worker provenance handoff.** On admission, `--recollect` clears `lastCleanupAt`, heartbeats continuously, and saves predecessor worker fields in `recollectionPriorWorker` so background pollers do not kill the live recollection worker as a stale terminal-cleanup process; warning-free teardown restores the predecessor identity, whereas teardown with warnings keeps the fresh identity so cleanup retries target the resources that exist (`SIGTERM` and `SIGINT` run the same finalizer).
- **Readers and leases.** `cleanupPending` and the live worker keep runtime and conversation leases occupied for the entire wait; these leases have no age-based expiry. A second recollection is refused while the worker or cleanup owns the job. Stale-active reconciliation ignores the still-failed job; terminal cleanup checks its fresh heartbeat instead. Existing notification and wake-up fields are retained: if failure already sent its one wake-up, successful recollection sends nothing to that session. The caller learns the result from the synchronous read itself.

## Same-thread follow-ups

Same-thread continuity is stored as job metadata (`chatUrl` and `conversationId`), never by holding open a browser process or tab between jobs:

- `/oracle-followup <job-id> <request>` passes `followUpJobId` to `oracle_submit`, which resolves a `complete` same-project job's saved `chatUrl` and `conversationId` (`follow_up_job_not_found`, `follow_up_job_wrong_project`, `follow_up_job_not_complete`, `follow_up_job_missing_chat_url`).
- `oracle_submit` also accepts `chatGptConversationId` (an id or `https://chatgpt.com/c/<id>` URL; `invalid_chatgpt_conversation_id` when malformed, `oracle_thread_target_conflict` if combined with `followUpJobId`) to continue a browser-created ChatGPT thread without prior job state.
- **Conversation lease refusal vs queueing.** When a runtime slot is free at admission, `oracle_submit` attempts to acquire the per-`conversationId` lease and refuses the submission immediately if another active job holds that conversation; it never queues behind an active job on the same thread.
- **Queued follow-up promotion.** A follow-up enters `queued` state only when all `browser.maxConcurrentJobs` runtime slots are busy (before `conversation` leases are checked), and `promoteQueuedJobs` later promotes it once both a runtime slot and the `conversation` lease are free, opening `chatUrl` in a fresh runtime clone or fresh pinned tab.

<a id="poller--wake-up-model"></a>
## Poller and wake-ups

Each live persisted host session outside `print` and `json` modes runs a background poller in `extensions/oracle/lib/poller.ts` (`poller.intervalMs`, default `5000 ms` from `DEFAULT_CONFIG` in `extensions/oracle/lib/config.ts`):

- **Process identity cache.** The host's own start time is cached for its lifetime; other live pids use a `2 s` (`2000 ms`) cache with `kill(pid, 0)` evicting dead entries on `ESRCH`.
- **Batched process-table priming.** Poll scans, reconciliation, queue promotion, `wakeup-target` scans, and footer updates batch-prime pids asynchronously via `ps` (`lstart`, preserving spacing for `workerStartedAt` comparisons) or PowerShell `Get-Process` (`5 s` timeout), falling back to synchronous reads only on error; spawn waits and signal-sending checks (`readProcessStartedAtFresh`) bypass the cache.
- **Non-blocking tick locks.** Each scan refreshes this session's `wakeup-target` lease (stale after `2 minutes`, `120000 ms`) and attempts the global `reconcile` and `admission` locks with a `50 ms` timeout (`POLLER_LOCK_TIMEOUT_MS`) so lock contention never stalls UI ticks.
- **Footer readiness and notifications.** Every poll re-evaluates submit prerequisites for the session footer (`oracle: ready`, `auth needed`, `browser unavailable`, `config error`) using the same error classification agents see. Only `browser_unavailable` and `config_error` emit `ui.notify` warnings—at most once per distinct state and message—while `auth_needed` updates the footer silently because its label already names `/oracle-auth`.
- **Delivery target.** A poller delivers a job's wake-up when the job belongs to its own session, or when the job belongs to the same project and its origin session holds no live `wakeup-target` lease (`jobCanNotifyContext`). A session in another project never delivers it.
- **Driver version cache.** The `agent-browser` `0.41.2` check caches its verdict (including in-flight promises) by resolved binary path, modification time, and file size so unchanged drivers spawn once.
- **Durable record.** Job durability sits in `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` (`job.json`, `response.md`, `artifacts/`), subject to `cleanup.*` retention, `/oracle-clean`, and the lifetime of the jobs directory.
- **Notification claims and retry schedule.** On `complete`, `failed`, or `cancelled`, the poller acquires a `60 s` claim (`ORACLE_NOTIFICATION_CLAIM_TTL_MS`, `notifyClaimedAt` / `notifyClaimedBy`) and checks activity, lifecycle, retention, and target gates (`isIdle()` and `hasPendingMessages()` defer busy sessions; hosts without them deliver immediately), allowing up to `3` attempts (`ORACLE_WAKEUP_MAX_ATTEMPTS`) at `0 s`, `15 s`, and `60 s` (`ORACLE_WAKEUP_RETRY_DELAYS_MS`).
- **Wake-up commit.** Commit increments `wakeupAttemptCount`, sets `wakeupLastRequestedAt` and `notifiedAt`, and always sends the marked batch via `{ triggerTurn: true, deliverAs: "followUp" }` even if the session turns busy or the poller stops mid-commit (skipping any job whose returned `notifiedAt` shows another poller already announced it).
- **Batching and settlement.** Jobs finishing together batch into one message. When the origin session reads a finished job through `oracle_read` before the first attempt, the job is settled with `wakeupSettledBeforeFirstAttempt: true` and no wake-up is sent. `/oracle-read` and `/oracle-status` before the first attempt record only `wakeupObservedAt`; after an attempt, any of the three records `wakeupSettledAt` and `wakeupSettledSource`, which stops the remaining attempts.
- **Consumption and retry guard.** Wake-up messages direct users to `/oracle-read [job-id]` and agents to `oracle_read`, include saved file paths, and instruct agents not to treat a `failed` or `cancelled` wake-up as an automatic `oracle_auth`, `oracle_submit`, or `oracle_cancel` retry trigger.

<a id="cleanup-maintenance-model"></a>
## Cleanup and retention

Runtime teardown, stale-job recovery, and retention pruning in `extensions/oracle/lib/jobs.ts` and `shared/job-lifecycle-helpers.mjs` are bounded and preserve completed job outputs:

- **Immediate runtime teardown.** Worker `finally` blocks, `/oracle-cancel`, and `/oracle-clean` release `runtime` and `conversation` leases, close the isolated browser (`10 s` timeout on `agent-browser close`) or pinned tab, and delete `runtimeProfileDir`. Stale lock directories are swept before `reconcile` runs.
- **Stale-job detection.** `reconcileStaleOracleJobs` marks an active job (`preparing`, `submitted`, `waiting`) failed when it has no `workerPid` after `30 s` (`30000 ms`, `ORACLE_MISSING_WORKER_GRACE_MS`), when its `workerPid` exited or mismatches `workerStartedAt`, or when its latest timestamp (`heartbeatAt`, `submittedAt`, or `createdAt`) is older than `3 minutes` (`180000 ms`, `ORACLE_STALE_HEARTBEAT_MS`).
- **Stale terminal-cleanup workers.** Terminal jobs with `cleanupPending` use the same `3 minutes` threshold from `lastCleanupAt` (then `heartbeatAt` or `completedAt`) before `reconcileStaleOracleJobs` terminates a wedged cleanup worker and retries teardown.
- **Bounded cleanup retries.** When teardown leaves warnings, `cleanupPending` is set, `cleanupAttemptCount` increments, and `cleanupRetryAt` schedules backoff across at most `5` total attempts: the initial attempt plus up to four retries spaced `15 s`, `1 min`, `5 min`, and `15 min` apart. On the fifth failed attempt, `cleanupPending` clears so background polls stop retrying and only an explicit `/oracle-clean` tries again (legacy jobs without `cleanupAttemptCount` get one reconciliation pass).
- **Capped diagnostics, preserved errors.** Cleanup warnings append to `logs/worker.log`, return to command callers, and persist in `cleanupWarnings` (deduplicated and capped at `8` entries of `500 characters` each). Warnings never overwrite `error` or `errorCode` and never block retention pruning once `cleanupPending` clears, though a worker whose own `finally` teardown produced warnings skips autonomous queue promotion so resources reconcile first.
- **Retention pruning and post-wake-up grace.** `pruneTerminalOracleJobs` removes terminal job directories once age from `completedAt` (or `createdAt`) reaches `cleanup.completeJobRetentionMs` (`complete` and `cancelled`) or `cleanup.failedJobRetentionMs` (`failed`) and `cleanupPending`, live `60 s` notification claims, and the `2 minutes` (`120000 ms`, `ORACLE_WAKEUP_POST_SEND_RETENTION_MS`) post-send retention grace measured from `wakeupLastRequestedAt` have all cleared.
- **Removal guard (`removeTerminalOracleJob`).** Both automatic pruning and `/oracle-clean` enforce the live-claim, live-worker, and `2 minutes` `wakeupLastRequestedAt` grace under the `job` lock, returning an ISO retry-after timestamp when blocked by that grace so follow-up turns never read deleted paths; for retention defaults and operator cleanup commands, see [Continue, cancel, and clean up](OPERATIONS.md#continue-cancel-and-clean-up).

## Design lineage

Earlier iterations automated the user's running Chrome without target pinning. That approach was rejected because `agent-browser tab new <url>` and `agent-browser tab <index>` switch the active tab and invoke CDP `Page.bringToFront`, stealing window focus and interrupting typing.

Replacing unpinned real-Chrome automation removed fixed port `9222` attachment, `cdpVerified`/`cdpUrl` job fields, parked reusable tabs, selected-tab index tracking, temporary `chrome://downloads` tabs, `downloads-manager.items_` scraping, and `~/Downloads` file-copy recovery.

Every transport preserves the no-focus-steal and no-global-scrape invariants: the default transport runs an isolated browser per job cloned from the auth seed profile, while the opt-in relay and managed-browser transports pin every CDP command to a single job-owned tab and capture artifacts in-realm or through frame-scoped CDP download events.

## Observations behind the rules

Dated empirical observations from driver and provider runs that motivated the invariants in earlier sections:

- **2026-11-09 — ChatGPT contenteditable batch insertion and normalized digest:** A loopback contenteditable tracer on macOS with driver 0.41.2 (2026-11-09) preserved embedded newlines, quotes, CJK, emoji and code fences; `fill` with an unknown ref exited 1. A batch with `--session`, `--cdp`, and `--pin-tab` navigated and filled only its newly pinned target while the other `about:blank` tab remained unchanged. Chrome rendered trailing spaces as non-breaking spaces, so the post-insertion proof compares NFC/whitespace-normalized length and SHA-256 in Node and the hydrated editor.
- **2026-11-09 — Driver session sidecars after close:** The same tracer left only `.target` after close, both in `~/.agent-browser` and with an explicit socket directory.
- **2026-11-09 — ChatGPT sidebar title after Send:** Snapshot and DOM signal filtering exclude sidebar subtrees because right after Send, ChatGPT titles the new chat in the sidebar with the prompt itself (observed 2026-11-09).
