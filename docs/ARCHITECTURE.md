# OMP Oracle architecture

How `omp-oracle` turns an `/oracle` request into a durable ChatGPT or Grok web job: the
host-side extension, the detached browser worker, the isolated auth seed profile (or the
opt-in existing-Chrome relay), and the persisted job state that outlives the agent turn.

Companion docs: [Security model](SECURITY.md) · [Compatibility](COMPATIBILITY.md) ·
[Operations](OPERATIONS.md) · [Test plan](TEST_PLAN.md) · [Release](RELEASE.md) ·
[Upstream](UPSTREAM.md)

Compatibility target:

- Oh My Pi and `pi` hosts; `pi` 0.80.9+ is the suggested tested floor for project-trust-aware package/runtime validation, and [Compatibility](COMPATIBILITY.md) records what is observed on OMP
- package metadata keeps pi runtime packages as optional wildcard peers, so this suggested floor is not enforced as a hard npm install requirement
- current extension lifecycle only; no backward-compatibility shims for removed `session_switch` / `session_fork` events

Verification: [Test plan](TEST_PLAN.md) for isolated-session smoke and the auth recovery drill;
[`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md) for the Crabbox macOS/Ubuntu gate
(`npm run smoke:platform:all`); [Release](RELEASE.md) for the full gate and evidence ledger.

## Goal

Create a `pi` extension that lets the user or agent consult ChatGPT.com or Grok through the web product instead of the API, with:

- manual invocation via `/oracle ...`
- automatic invocation by the agent in rare high-difficulty cases
- mandatory project-context archive upload (`.tar.zst` for ChatGPT, `.tar.gz` for Grok)
- long-running execution in the background
- durable response/artifact persistence plus best-effort wake-the-agent behavior when the oracle response is ready
- oracle requires a persisted pi session identity; in-memory/no-session contexts are rejected instead of risking cross-session wake-up misdelivery
- legacy project-scoped jobs from the older no-session model remain inspectable by project, but are treated as manual/status-only instead of being rebound to a different persisted session for wake-up delivery
- persisted responses and artifacts under `/tmp`
- optional same-thread follow-up questions later

## Architecture decision

The production architecture is now:

- use `agent-browser`
- do **not** automate the user’s real Chrome in production
- maintain one authenticated **seed profile** via `/oracle-auth`
- clone that seed into a **per-job runtime profile** for each oracle run
- launch each job in its own **runtime browser session**
- persist same-thread continuity by saved `chatUrl`, not by keeping tabs or browsers alive
- allow parallel jobs only when they do not target the same provider conversation

## Rejected: unpinned real-Chrome automation

The old real-Chrome/CDP architecture is rejected for production.

Why:

- `agent-browser tab new <url>` opens a new tab and selects it
- `agent-browser tab <index>` switches the active tab
- upstream `agent-browser` source calls `Page.bringToFront` during tab switching
- this stole focus in the user’s real environment and disrupted typing

That violates a hard requirement.

Real-Chrome automation was useful for investigation and earlier smoke tests, but it is no longer the target architecture.

The fork's opt-in relay transport (below) is a different design: it never switches tabs or brings a page to front. Every browser command is pinned to one job-owned tab, so it does not reintroduce this failure mode.

## Current extension surface

The extension now follows the current `pi` session lifecycle model:

- session transitions are handled from `session_start`
- previous runtimes are expected to clean up in `session_shutdown`
- no new logic depends on removed post-transition events

### Oracle dispatch commands

- `/oracle <request>`
  - in TUI mode, intercepted by the extension before prompt-template expansion so verbose internal workflow rules stay hidden from the visible transcript
  - injects the detailed dispatch instructions as a hidden custom message
  - in print/json/rpc modes, the extension contributes the prompt templates so non-interactive prompt expansion still works
  - asks the agent to gather context and dispatch an oracle job
- `/oracle-followup <job-id> <request>`
  - follows the same hidden-instructions TUI path and print/json prompt-template fallback
  - asks the agent to continue an earlier oracle job in the same provider thread via `followUpJobId`
  - keeps same-thread continuation available to normal users without requiring raw tool-call syntax

### Commands

- `/oracle-auth [chatgpt|grok]`
  - syncs ChatGPT or Grok cookies from the configured local browser profile into the isolated oracle profile and verifies them there, based on the configured default provider or explicit command argument
- `/oracle-read [job-id]`
  - shows job status plus the saved response preview
- `/oracle-status [job-id]`
  - shows job status and lists recent job ids when the caller omits an explicit id
- `/oracle-cancel <job-id>`
  - cancels a queued or active job by id; does not guess a default target
- `/oracle-clean <job-id|all>`
  - removes temp files for terminal jobs only

### Tools

- `oracle_preflight`
  - lightweight agent-facing readiness check for persisted-session and local oracle prerequisites
  - accepts optional `provider` and `followUpJobId` so readiness checks use the same auth seed/provider that submission will use
  - intended to run before expensive `/oracle` context gathering
- `oracle_auth`
  - agent-facing auth refresh tool that mirrors `/oracle-auth` for stale-auth recovery before a retry
- `oracle_submit`
  - low-level agent-facing dispatch tool
  - creates archive and launches a detached worker
  - supports optional `followUpJobId` to continue the same provider thread by persisted URL
- `oracle_read`
  - reads job status and outputs
- `oracle_cancel`
  - cancels a queued or active job

## High-level flow

### `/oracle ...`

`/oracle <request>` should not directly drive ChatGPT or Grok.
In TUI mode, the extension intercepts it before prompt-template expansion, re-injects the compact slash request as the visible user message so prompt-history/up-arrow recall survives session reloads, injects hidden dispatch instructions before the agent starts, and shows only compact user-facing status. In print/json/rpc modes, the extension exposes the prompt template so one-shot `/oracle` still expands and runs normally.

It instructs the agent to:

1. call `oracle_preflight` immediately, passing `provider: "grok"` when the user explicitly asks for Grok
2. stop right away if preflight reports the session or local oracle setup is not ready
3. understand whether the request is explicitly narrow or genuinely broad
4. if auth is missing, stale, or the worker explicitly said to rerun `/oracle-auth`, stop and tell the user to run `/oracle-auth` rather than launching auth automatically
5. gather enough repo context to submit well and bias toward context-rich archives when they fit within the provider ceiling: 250 MiB for ChatGPT and 200 MiB for Grok
6. if the request is narrow, start from the directly relevant area but still include nearby tests, docs, config, and adjacent modules when they may improve answer quality
7. if the request is broad/repo-wide, gather broader context and usually archive `.`
8. if `oracle_submit` fails before dispatch with an `archive_too_large` / upload-limit error, treat that as retryable: use the reported size summary plus any auto-pruned paths to cut scope and retry automatically with a smaller archive
9. stop retrying after at most two total submit attempts for the same request; if it still does not fit, report what was cut and why
10. craft the oracle prompt
11. call `oracle_submit`
12. stop and wait for the completion wake-up (best-effort; durable oracle response/artifact state is already persisted outside session history)

### `/oracle-auth`

Auth bootstrap flow:

1. load oracle config
2. acquire the global auth-maintenance lock
3. read ChatGPT or Grok cookies directly from the configured local browser cookie store in read-only mode, depending on `defaults.provider`
   - configurable source profile / cookie DB path
   - optional configured Chromium Keychain source for browsers outside the default importer
   - no launch or mutation of the real browser profile
4. validate that `browser.authSeedProfileDir` is an absolute safe path and not inside the real Chrome user-data tree
5. create a staged seed-profile path next to the target seed profile
6. launch the isolated auth browser headed with:
   - dedicated auth `--session`
   - dedicated staged seed `--profile`
   - configured executable path / user agent / launch args if set
7. clear isolated browser cookies and seed the staged profile with imported provider cookies
8. open the configured provider in the isolated browser
9. verify auth with provider-specific readiness checks
10. on success, close the isolated browser so Chrome flushes profile state cleanly
11. atomically swap the staged profile into `browser.authSeedProfileDir`, keeping `*.prev` as rollback
12. write a seed-generation marker used by future runtime clones
13. if the provider presents a challenge page, leave the staged auth browser/profile open for the user to solve and reuse

This keeps production oracle jobs off the user’s real Chrome while using the user’s existing authenticated provider cookies as the bootstrap source. Each run writes its diagnostics to a private per-run directory — `/tmp/pi-oracle-auth-*/oracle-auth.log` plus URL, accessibility-snapshot, and body captures — and prints that path.

The authenticated seed profile remains the source of truth for future oracle runtimes.

### `oracle_submit`

Agent-facing submissions resolve a provider first. ChatGPT submissions use **`preset`**; the canonical registry is `ORACLE_SUBMIT_PRESETS` in `extensions/oracle/lib/config.ts`. Grok submissions use **`mode: "heavy"`** today and reject ChatGPT-only presets. For ChatGPT, **`preset` is the only model-selection parameter** on `oracle_submit`; there are no `modelFamily`, `effort`, or `autoSwitchToThinking` fields. Submit-time inputs accept canonical preset ids plus matching human-readable labels/common hyphen-space variants, and the tool normalizes them back to the canonical id before persisting job state. Prompt-template guidance biases toward omitting provider/model fields and using configured defaults unless the task or user explicitly asks for one. It also biases toward context-rich archives up to the provider ceiling, narrowing only when the user explicitly asks for a tight archive, privacy/sensitivity requires it, or size pressure forces it. When local archive creation still exceeds that ceiling after default exclusions and whole-repo auto-pruning, prompt guidance now treats the failure as a retryable archive-selection miss rather than a terminal dead end: agents should cut scope automatically, retry once or twice, and only surface the cut decisions if the archive still cannot fit.

1. resolve the provider and preset/mode (submit-time or config default) into an execution snapshot
2. resolve optional thread targeting:
   - `followUpJobId` into a prior oracle job `chatUrl` and `conversationId`, or
   - `chatGptConversationId` into a user/browser-created ChatGPT `https://chatgpt.com/c/<id>` URL
   Omit both for the default fresh-thread behavior.
3. build the archive first into a temporary path
4. allocate a unique runtime:
   - `runtimeId`
   - `runtimeSessionName`
   - `runtimeProfileDir`
5. under the global admission lock, first promote any older queued jobs that can now run
6. if runtime capacity is still available:
   - acquire the runtime lease
   - acquire the conversation lease for same-thread jobs, including follow-ups and explicit existing ChatGPT conversation ids
   - create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` job state as `submitted`
7. otherwise create `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/...` job state as `queued`
8. move the prepared archive into the job directory with a unique filename
9. spawn a detached worker only for submitted jobs
10. return immediately
11. stop the agent turn until the completion wake-up arrives (best-effort; durable oracle response/artifact state is already persisted outside session history)

### Worker run flow

Per job:

1. clone the authenticated seed profile into the job’s `runtimeProfileDir` under the auth lock
2. launch a fresh isolated browser with:
   - the job’s `runtimeSessionName`
   - the job’s `runtimeProfileDir`
   - headless by default
3. open either:
   - the saved `chatUrl` for follow-up jobs,
   - the normalized `chatGptConversationId` URL for explicit existing ChatGPT browser threads, or
   - the configured provider URL
4. classify page state before touching the UI
5. fail fast on:
   - login required
   - challenge/verification page
   - transient outage after one retry
6. configure ChatGPT model family/effort or Grok Heavy
7. upload archive
8. wait for upload confirmation scoped to the active composer
9. fill prompt
10. send
11. wait for a stable conversation URL and persist `chatUrl` / `conversationId`
12. wait for completion anchored to the current turn only; for a composer-tool preset (Deep
    Research) the tool is enabled after the prompt is filled and before the upload and verified by
    its pill, model configuration is skipped, CDP frame capture is armed on the pinned relay tab
    before send (`Target.setAutoAttach` is not retroactive), and once the assistant turn shows the
    research widget the report is polled from the attached iframe session
    (`frames[0].document.body.innerText`) until `Research completed in` appears; a reply instead
    of a research start, a missing tool, or an unreadable widget fail with a stable `errorCode`
13. bind the completed assistant turn (`conversationId` + `responseIndex`, then the exact
    `data-message-id` and a content hash) and record `generationStatus: completed`
14. collect the bound turn only (never the whole conversation): scoped DOM evidence, exact code
    payloads, derived Markdown, stable source URLs, and any response-local artifacts, writing
    `response.capture.json` plus `collectionStatus` with required/optional gaps
15. close the isolated browser session and delete the runtime profile in `finally`

## Existing-Chrome relay transport

The same endpoint option can attach directly to native Chrome CDP on a dedicated persistent
user-data directory. The wire protocol and per-job tab ownership are unchanged; account
isolation comes from Chrome’s separate storage, not an account switcher. See
[dedicated-account setup](OPERATIONS.md#dedicated-account-in-persistent-chrome). The worker
does not own that browser process or verify a configured email identity.

The fork adds an opt-in ChatGPT transport that drives the user's already signed-in Chrome through a CDP relay instead of cloning cookies into an isolated profile. It is enabled only by the agent-level `browser.chatGptRelayEndpoint` option (for example `http://127.0.0.1:9224`); project config cannot set it, and it applies to ChatGPT only. Grok keeps the isolated-profile route. Without the option, behavior is unchanged.

- The relay must expose CDP target discovery (`Target.getTargets`), creation, attachment, and closure. Older OMP relay builds without `Target.getTargets` cannot serve `agent-browser`; use `agent-browser` 0.35.0 or newer with pinned-tab support.
- Each job creates a fresh tab, persists its opaque target identity in job state, and pins every browser command to that tab. Cleanup checks ownership, closes the pinned tab, verifies its removal, and disconnects the job driver. Relay mode never deletes a profile directory.
- The job-owned tab is never activated (focus stealing is a hard requirement, see above), so whenever it sits behind another tab, in a minimized window, or in a window occluded by other windows, Chrome reports it `hidden` and gives it no rendering opportunities: `requestAnimationFrame` never fires and timers throttle to one per second. ChatGPT appends streamed tokens from the render loop, so the streamed turn freezes mid-stream while the network-driven stop control still clears. The worker therefore treats the streamed read as a lower bound and reconciles it against a reload of the persisted conversation, which renders the committed turn correctly even while hidden. Measured against a throwaway Chrome: `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` keep an occluded window's active tab `visible` (rAF 120/s), but a background tab or a minimized window stays `hidden` with rAF at 0 (timers 5/s instead of 1/s). The flags are worth setting on a dedicated diligence Chrome that lives behind other windows; they cannot replace the reconciliation.
- The converse also happens: the stop control can outlive a finished stream (observed for 31 minutes over a fully rendered turn whose generation request had returned 200 at t+14 s). Once the bound turn's text has been non-empty and unchanged for two minutes under a persistent stop control, the worker reloads the conversation and re-reads generation state (`nextStaleStopState`); empty text never ages, so thinking phases are untouched, and Deep Research is exempt because it holds its control by design and reads the report from the widget frame.
- Follow-ups open a new job-owned tab on the existing conversation URL. A missing or mismatched target fails closed rather than selecting another tab.
- Relay preflight checks transport reachability, not login. The worker verifies login before uploading. Login and human-verification challenges are finished in Chrome by the user; `oracle_auth` refuses cookie import in relay mode.
- The submit/read/follow-up APIs and the durable job files are unchanged between transports.

## Persistence model

### Default auth persistence

Default and recommended:

- auth seed via `--profile <authSeedProfileDir>` for durable provider authentication state
- per-job runtime via unique `--session <runtimeSessionName>` + unique `--profile <runtimeProfileDir>`

Not the default:

- `--session-name`
- `state save/load` as the primary auth bootstrap path

Reason:

`--profile` is the broadest persistence primitive and preserves full browser profile state such as cookies, localStorage, IndexedDB, service workers, cache, and login sessions. The safe concurrent design is therefore:

- one persistent authenticated seed profile
- many disposable runtime profile clones derived from that seed

## Config files

Merged config locations:

- global: `~/.pi/agent/extensions/oracle.json` on `pi`, `~/.omp/agent/extensions/oracle.json` on Oh My Pi (the host's agent directory plus `extensions/oracle.json`)
- project: `.pi/extensions/oracle.json` on `pi`, `.omp/extensions/oracle.json` on Oh My Pi (the host's config directory name)

Project config remains restricted to safe overrides only. On Pi 0.79+, pi itself gates project-local inputs behind project trust, but `omp-oracle` keeps its historical risk-on extension behavior for this package-specific safe override file: `.pi/extensions/oracle.json` loads by default for compatibility, and is ignored when Pi reports the project is untrusted, including `--no-approve` or saved “do not trust” decisions. This preserves the existing extension experience while still honoring explicit opt-out/distrust decisions. Browser/auth settings remain global-only because they control local privileged browser state.

### Current config shape

```json
{
  "defaults": {
    "provider": "chatgpt",
    "preset": "<preset id from ORACLE_SUBMIT_PRESETS>",
    "grokMode": "heavy"
  },
  "browser": {
    "sessionPrefix": "oracle",
    "authSeedProfileDir": "<absolute path to oracle auth seed profile>",
    "runtimeProfilesDir": "<absolute path to oracle runtime profiles dir>",
    "maxConcurrentJobs": 2,
    "cloneStrategy": "copy",
    "chatUrl": "https://chatgpt.com/",
    "authUrl": "https://chatgpt.com/auth/login",
    "runMode": "headless",
    "executablePath": "<optional absolute path to Chrome/Chromium executable>",
    "userAgent": "<optional real-Chrome UA override>",
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "auth": {
    "pollMs": 1000,
    "bootstrapTimeoutMs": 600000,
    "chromeProfile": "<optional Chrome/Chromium profile name>",
    "chromeCookiePath": "<optional absolute path to Chromium Cookies DB>",
    "chromiumKeychain": {
      "account": "<macOS-only Keychain account for non-built-in Chromium browsers>",
      "services": ["<safe-storage service name>"],
      "label": "<optional human-readable label>"
    }
  },
  "worker": {
    "pollMs": 5000,
    "completionTimeoutMs": 5400000
  },
  "poller": {
    "intervalMs": 5000
  },
  "artifacts": {
    "capture": true
  },
  "cleanup": {
    "completeJobRetentionMs": 1209600000,
    "failedJobRetentionMs": 2592000000
  }
}
```

`browser.cloneStrategy` defaults to `apfs-clone` on macOS and `copy` on Linux/Windows. macOS APFS clone mode uses `cp -cR` and preflights `cp`; set `PI_ORACLE_CP_PATH` only when the default PATH lookup cannot find the intended copy executable. Linux and Windows runtime profile copies use Node's recursive copy instead of depending on POSIX `cp`.

The default `/oracle-auth` cookie importer delegates to `@steipete/sweet-cookie`'s Chrome/Chromium backend. On Linux, the importer auto-detects existing Google Chrome, Chromium, Chromium Browser, or Brave profile roots under `${XDG_CONFIG_HOME:-~/.config}` and passes non-Google roots as absolute profile paths so Sweet Cookie reads the intended cookie DB. Sweet Cookie's Edge and Firefox backends are not selected. Encrypted Linux Chromium cookies are handled by Sweet Cookie via `secret-tool`, `kwallet-query`/`dbus-send`, `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic`, or the `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` / `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` overrides. Prefer keyring helpers over password environment variables; if a password override is used for `/oracle-auth`, it is scrubbed from the environment before launching browser/helper subprocesses after cookie import.

`auth.chromiumKeychain` is a macOS-only opt-in alternate cookie source for Chromium-family browsers that are not handled by the default `@steipete/sweet-cookie` Chrome-compatible importer. It must be configured with `auth.chromeCookiePath`; partial config is rejected so `/oracle-auth` cannot silently fall back to a different browser profile. On Linux, valid config should leave `auth.chromiumKeychain` unset and use Sweet Cookie's Linux keyring/password options instead.

When both `auth.chromeCookiePath` and `auth.chromiumKeychain` are present on macOS, auth bootstrap:

1. reads the configured macOS Keychain safe-storage password using `account` and the ordered `services` list
2. snapshots the Chromium `Cookies` DB plus `Cookies-wal` / `Cookies-shm` sidecars, tolerating sidecars that disappear while the browser is closing
3. decrypts Chromium AES-CBC cookie values, including Chromium v24+ host-hash-prefixed values
4. dedupes duplicate cookie rows by keeping the first row after newest-expiry ordering
5. filters importable provider auth cookies and seeds the isolated oracle auth profile

Operational requirements for this macOS-only path:

- ChatGPT or Grok must already be logged in in the configured browser profile, depending on the provider being synced.
- The target browser should be fully quit before `/oracle-auth` so the cookie DB snapshot is stable.
- The configured Keychain item must be accessible to the current macOS user; allow Keychain access if prompted.
- `browser.executablePath` should point at the same Chromium-family browser so the headed auth/bootstrap browser uses the intended app.

## Cleanup maintenance model

Long-run hygiene is intentionally conservative:

- runtime profiles, runtime leases, and conversation leases are cleaned immediately as part of worker/command cleanup paths
- browser close is time-bounded so cleanup can continue even if `agent-browser close` wedges
- `/oracle-clean` performs runtime cleanup before removing the persisted job directory, but refuses terminal jobs whose worker is still live or whose wake-up was just sent inside a short post-send retention grace window; when blocked by that grace it returns a retry-after timestamp
- stale lock directories are swept before reconcile maintenance
- old auth `.staging-*` profiles are swept during `/oracle-auth` startup when the auth browser session is not still active
- terminal job directories are retained for inspection, then pruned later based on configurable retention windows

Current retention policy is configurable via `cleanup.*`:

- `cleanup.completeJobRetentionMs`
  - applies to `complete` and `cancelled` jobs based on terminal-job age; wake-up delivery remains best-effort only, with a short post-send grace so saved response/artifact paths survive the follow-up turn
- `cleanup.failedJobRetentionMs`
  - applies to `failed` jobs

Cleanup warnings are treated as diagnostics, not silent no-ops:

- worker cleanup warnings are appended to `logs/worker.log`
- command-side cleanup warnings are surfaced to the user
- cancellation/stale-job recovery persists cleanup warnings into `job.json`
- terminal cleanup recovery will terminate stale live cleanup workers before retrying teardown so blocked capacity does not wedge indefinitely

## Job layout under the configured jobs dir

Default location: `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`

```text
${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/
  job.json
  prompt.md
  context-<job-id>.tar.zst   # ChatGPT
  context-<job-id>.tar.gz    # Grok
  response.md                # response (native Markdown export, exact code payload, or derived Markdown)
  response.capture.json      # binding, method, fidelity, sources, code blocks, gaps, artifact inspection
  response.raw.txt           # bound-turn evidence: innerText
  response.raw.html          # bound-turn evidence: sanitized DOM (active content, transient attributes, signed URLs removed)
  response.block-<n>.txt     # exact text of each leaf code block in the bound turn
  artifacts.json
  artifacts/
    <sha256>-<file name>     # validated downloads only
  logs/
    worker.log
    ...diagnostic captures on failure...
```

### `job.json` fields

Important fields include:

- `id`
- `status`: `queued | preparing | submitted | waiting | complete | failed | cancelled`
- `phase`: `queued | submitted | cloning_runtime | launching_browser | verifying_auth | configuring_model | uploading_archive | awaiting_response | extracting_response | downloading_artifacts | complete | complete_with_artifact_errors | failed | cancelled`
- `phaseAt`
- `createdAt`
- `queuedAt`
- `submittedAt`
- `completedAt`
- `heartbeatAt`
- `cwd`
- `projectId`
- `sessionId`
- `originSessionFile`
- `requestSource`
- `selection`: resolved execution snapshot with `{ provider, preset?, mode?, modelFamily, effort?, autoSwitchToThinking }`
- `followUpToJobId`
- `chatUrl`
- `conversationId`
- `responsePath`
- `responseFormat` (`text/plain`)
- `generationStatus` (`completed` once the assistant turn finished; independent of collection)
- `collectionStatus` (`complete | partial | failed`), `collectionRequiredMissing`,
  `collectionOptionalMissing` (see [Collection](#collection))
- `collectionBinding` (`{ conversationId, responseIndex, messageId?, turnSha256?, frameId? }`)
- `responseCapturePath`
- `recollectionError` (last `oracle_read` recollection failure, cleared on success)
- `artifactPaths`
- `artifactsManifestPath`
- `archivePath`
- `archiveSha256`
- `archiveDeletedAfterUpload`
- `notifiedAt`
- `notificationEntryId`
- `notificationSessionKey`
- `wakeupAttemptCount`
- `wakeupLastRequestedAt`
- `wakeupSettledAt`
- `wakeupSettledSource`
- `wakeupSettledSessionFile`
- `wakeupSettledSessionKey`
- `wakeupSettledBeforeFirstAttempt`
- `wakeupObservedAt`
- `wakeupObservedSource`
- `wakeupObservedSessionFile`
- `wakeupObservedSessionKey`
- `notifyClaimedAt`
- `notifyClaimedBy`
- `artifactFailureCount`
- `error`
- `cleanupWarnings`
- `lastCleanupAt`
- `workerPid`
- `workerNonce`
- `workerStartedAt`
- `runtimeId`
- `runtimeSessionName`
- `runtimeProfileDir`
- `seedGeneration`
- `config`

## Response format

Canonical oracle response format remains:

- `text/plain`

The saved file path is currently `response.md` for continuity with earlier job layouts, but the content contract is normalized plain text for agent consumption.

## ChatGPT page-state classifier

Before upload/send, the worker classifies ChatGPT as one of:

- `authenticated_and_ready`
- `login_required`
- `challenge_blocking`
- `transient_outage_error`
- `unknown`

Signals used:

- current URL
- accessibility snapshot
- body text

### Ready

Require all of:

- ChatGPT origin is correct
- not on `/auth/*`
- composer exists
- `Add files and more` exists
- model selector / selected model control exists
- no login/challenge/outage signals

### Login required

Any of:

- URL on `/auth/*`
- login/provider signals like `Log in`, `Sign up`, `Continue with Google`, etc.
- logged-out page shape where a composer may exist but required oracle controls do not
- redirect away from the expected ChatGPT origin

### Challenge blocking

Examples:

- `Just a moment`
- `Verify you are human`
- `Cloudflare`
- captcha / turnstile markers
- suspicious or unusual activity messages

### Transient outage

Examples:

- `Something went wrong`
- `A network error occurred`
- websocket error text
- `Try again later`

## Collection

Generation and collection are separate facts. `generationStatus: completed` records that the
assistant finished the turn; `collectionStatus` records how much of that turn the worker holds:

- `complete` — response saved with nothing missing
- `partial` — response saved, but named gaps remain
- `failed` — no usable response bytes

Gaps are explicit strings. Required gaps mean the answer itself is degraded (`response`,
`rich_response_fidelity`, `unresolved_source_links`, `bound_response_capture`,
`redacted_transport_links`, `native_export_source_links`); optional gaps mean a secondary file is
missing (`native_markdown_export`, `artifact:<candidate>`, `artifact_inspection:<state>`). Legacy
jobs without these fields stay readable; absence is unknown, not failure.

### Exact binding

Collection binds to one assistant turn: `conversationId` (checked against the live URL),
`responseIndex` (the position observed at completion), and once captured the exact
`data-message-id` plus a `turnSha256` of the turn's normalized text (class attributes churn
between renders, so the sanitized HTML is not hashed). Actual ChatGPT headings wrap a descendant
`data-message-id`, so the binding resolves through the heading wrapper; message identity wins over
a stale positional index, and a missing or ambiguous identity fails closed instead of capturing
the last answer or the whole conversation.

### Capture

`extensions/oracle/worker/response-capture.mjs` holds closure-free browser functions that the
worker evaluates in the owned page or the bound report frame and that the synthetic Chromium proof
runs unchanged. From the bound root it produces raw text, sanitized HTML, derived Markdown, leaf
`pre` code blocks (nested presentation wrappers are not double-counted; language classes may be
absent), stable source URLs (signed transport URLs are dropped; literal URLs in text and code are
inventoried), structural artifact candidates, and child frames. A single `markdown` code block is
saved as the exact response (`exact_code`); Deep Research prefers the native export
(`native_markdown`); otherwise the derived Markdown is saved (`derived_markdown`). Exact payload
files and the surrounding derived response are distinct fidelity claims.

### Artifacts

Candidates come only from the bound turn (or bound report frame): controls with `download`
attributes, file-like hrefs, or export labels. Each candidate is recorded as `discovered`,
`downloaded`, `validated`, or `failed` in `artifacts.json`; validated bytes are checked against
their declared size and format (PDF/ZIP/PNG/UTF-8 text) before they land under
`artifacts/<sha256>-<name>`. Identical bytes are stored once, and a candidate whose validated file
already exists is not downloaded again.

Turn artifacts are captured in the page realm: the control is activated under temporary
`fetch`/`open`/anchor hooks that read the UI's own download bytes, with the driver's native
`agent-browser download <ref> <dest>` as the fallback.

A Deep Research report lives in a sandboxed cross-origin App iframe, and its Export → Export to
Markdown menu delegates the download to the host page, so no hook inside the frame can see the
bytes. The worker therefore pre-arms native download observation before activating the control:
`Page.enable` on both the pinned tab session and the bound frame session so Chrome's
`Page.downloadWillBegin` / `Page.downloadProgress` events arrive through the relay, plus an
object-URL registry in each realm that remembers the `Blob` behind every `URL.createObjectURL`
while armed. A download is accepted only when it begins in the tab's main frame or in the bound
report frame tree; its bytes are read from the registered `Blob` (or decoded from a `data:` URL),
checked against Chrome's `totalBytes`, and validated as Markdown that carries the report title.
`Browser.setDownloadBehavior` is not routed by the extension relay and is never sent: the user's
download destination is untouched, Chrome keeps its own copy in its configured download
directory, and the relay reports no saved path, so no directory is scanned. A download from a
transport URL the hooks did not read is reported as a precise optional gap rather than refetched.

This deliberately avoids `chrome://downloads`, downloads-tab ownership logic, browser-global
download history heuristics, focus-sensitive tab hacks, and any change to the browser's download
behavior. Visible labels are display metadata, never authoritative filenames.

### Recollection

`oracle_read({ jobId, action: "recollect" })` retries collection of an already completed job
without sending anything: the worker's separate `--recollect` entrypoint never reaches configure,
upload, composer, or send. Jobs completed before binding existed require the observed
`responseIndex` and `messageId` together; the latest turn is never inferred, an explicit pair may
add the identity of a saved positional turn but never move it, and an explicit binding can never
replace a saved exact one. Recollection opens a fresh `oracle-<uuid>` driver session (the original
tab is gone, and a longer suffix would exceed macOS's 103-byte Unix socket path), arms frame
capture before navigating, reacquires the exact turn, collects, and finalizes. Earlier usable
bytes always survive: a failed recollection records `recollectionError`, marks
`bound_response_capture` missing, and keeps the previous `response.md` and validated artifacts;
a message identity learned before a later failure stays persisted.

While a recollection runs, the completed job is terminal, cleanup-pending, and has a live worker.
Terminal-cleanup reconciliation judges such a worker by `lastCleanupAt` before `heartbeatAt`, so
admission retires the predecessor's `lastCleanupAt` and heartbeats throughout (profile cloning on
the isolated transport included); otherwise an extension poller in any live session would
terminate the worker mid-collection as a stale cleanup worker. Admission also persists the
predecessor's provenance as `recollectionPriorWorker` rather than holding it in memory: after a
warning-free teardown the predecessor identity is restored and the record removed, while after a
cleanup warning the fresh identity stays persisted so reconciliation retries against the resources
that actually exist. SIGTERM/SIGINT during recollection run the same cleanup and finalization.

Browser teardown waits until the driver no longer lists the session before returning, because
`agent-browser close` returns while its daemon is still serving: a same-name command in that
window is served by the dying daemon and its tab is orphaned. A session the driver does not list
is never closed (the driver would spawn a daemon and a stray tab just to close it), an unreadable
driver inventory is a cleanup error rather than evidence of absence, and a relay target the
inventory no longer lists never reaches the driver at all.

Identity limits are explicit. A positional root that spans several message identities is refused
even on first capture. A root that carries no `data-message-id` at all (attribute drift) binds
positionally by content hash because its index was observed live at completion; recollection then
refuses that index-only binding unless the hash still matches, so drift degrades to a refused
recollection rather than to a different turn.

## Same-thread follow-ups

Same-thread continuity is persisted as data, not runtime browser state.

Approach:

- expose `/oracle-followup <job-id> <request>` as the user-facing way to continue an oracle-created provider thread later
- allow `/oracle`/`oracle_submit` to opt into a browser-created ChatGPT thread only when the user explicitly supplies `chatGptConversationId` as a raw id or `https://chatgpt.com/c/...` URL
- store `chatUrl` only after the conversation URL stabilizes
- derive and persist `conversationId` from that URL when possible
- for a follow-up job, resolve `followUpJobId` to the prior `chatUrl`
- for an explicit existing ChatGPT thread, normalize `chatGptConversationId` to `https://chatgpt.com/c/<id>` without requiring prior oracle job state
- acquire a conversation lease before launching the same-thread job
- launch a fresh isolated browser using a fresh runtime clone of the auth seed
- open that URL
- continue there if authentication and page-state checks pass

Do not keep a browser or tab alive between jobs just to preserve thread continuity.
Do not allow concurrent jobs to target the same `conversationId`.

## Poller / wake-up model

The extension still uses the same general `pi`-native background completion pattern, but notification semantics are now explicit:

- detached worker writes `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-*` state
- poller scans jobs on an interval
- each poll also re-runs the submit prerequisite check behind the session footer (`oracle: ready`, `auth needed`, `relay unavailable`, `config error`), classified by the same error codes agents receive; a relay or config blocker raises one warning per distinct cause, and the footer follows the blocker clearing or returning without a new session
- completed job durability lives in oracle job state plus saved response/artifact files, not in synthetic session-history assistant messages
- when a matching job reaches `complete`, `failed`, or `cancelled`, the poller issues one best-effort wake-up to whichever matching session is currently live, then records `notifiedAt` so later scans do not duplicate the completion message
- those wake-ups direct the receiver to `/oracle-read [job-id]` as the primary completion-consumption path, while still surfacing saved response/artifact paths as secondary context; `/oracle-status` remains useful for metadata and job-id discovery, and agent callers can still use `oracle_read` when they need tool output in-turn
- wake-up content explicitly tells agents not to treat completion as an automatic `oracle_auth`, `oracle_submit`, or `oracle_cancel` retry instruction
- manual `oracle_read`, `/oracle-read`, or `/oracle-status` inspection after a wake-up persists provenance about which path/session settled the wake-up
- if no wake-up lands, the job remains available via `/oracle-read`, `/oracle-status`, `oracle_read`, and the saved `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` response/artifact files
- because completion delivery is best-effort, pruning uses explicit terminal-job age policy plus `notifiedAt`/wakeup state instead of pretending a durable session notification was appended
- recently sent wake-ups keep response/artifact files retained briefly so follow-up turns do not point at deleted paths if cleanup or pruning races with delivery

## Superseded real-Chrome machinery

The isolated-profile design deletes or supersedes the old real-Chrome-specific machinery:

- CDP attach/verification to port `9222`
- `cdpVerified` / `cdpUrl` job state
- dedicated oracle tab parking/reuse in the user’s browser
- wrong-tab drift handling
- selected-tab / tab-index tracking
- temporary `chrome://downloads` tabs
- browser download-manager scraping via `downloads-manager.items_`
- copy-from-`~/Downloads` artifact recovery flow
