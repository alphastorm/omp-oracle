# OMP Oracle test plan

This test plan is for contributors and maintainers choosing and running the validation check that proves a change in OMP Oracle (`omp-oracle`) for Oh My Pi (OMP) or `pi`. Start with the local gate (`npm run verify:oracle`), then add live or cross-platform checks only when the changed surface requires them.

Companion docs: [Architecture](ARCHITECTURE.md) · [Operations](OPERATIONS.md) · [Platform smoke](PLATFORM_SMOKE.md) · [Release](RELEASE.md)

## Which check to run

Match the surface you changed to the narrowest check that proves it:

| Situation | Run | Proves |
| --- | --- | --- |
| Everyday local iteration (local gate) | `npm run verify:oracle` (`npm test` is an alias) ([Local gate](#local-gate)) | Ten fast local checks pass: syntax, bundle, smoke invariants, unit, site, and doc tests, three typechecks, sanity, and dry-run pack. |
| Native `pi` status and read smoke | `node --test scripts/oracle-native.test.mjs` ([Native `pi` status and read smoke](#native-pi-status-and-read-smoke)) | Installed `pi` dispatches `/oracle-status` and `/oracle-read` offline, enforces cross-project `projectId`, and persists observed selections. |
| Response capture or recollection change | `npm run proof:capture` ([Collection proof](#collection-proof)) | Headless Chromium against local fixture pages proves composer hydration, turn binding, code and Deep Research capture, and recollection. |
| Platform-focused syntax and invariant sanity | `npm run check:platform-smoke`, `npm run sanity:oracle:platform`, or `npm run verify:oracle:platform` ([Platform checks](#platform-checks)) | Crabbox harness invariants, real-smoke syntax, platform-sensitive sanity assertions, and `npm pack --dry-run` pass before launching targets. |
| Runtime or extension code change | [Isolated `pi` session smoke](#isolated-pi-session-smoke) | Local extension loads in isolated `pi` or `omp` sessions, excludes local tool state, rejects symlink escapes, and gathers agent feedback. |
| Managed-browser change | [Managed browser mode](#managed-browser-mode) | `browser.chatGptManagedProfileDir` launch, attach, per-command browser-identity checks, and the idle keeper quit succeed in an isolated state directory. |
| Auth seed or bootstrap change | [Auth recovery drill](#auth-recovery-drill) and [Auth timeout check](#oracle-auth-timeout-when-agent-browser-hangs) | Unauthenticated seeds fail at submission before archiving, `/oracle-auth` repairs the seed and aborts hung drivers, and the next job completes. |
| Platform-sensitive change | `npm run smoke:platform:doctor`, then `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` ([Platform smoke](PLATFORM_SMOKE.md)) | Doctor preflight and the affected target (`macos` or `ubuntu`) and suite (`platform-build` or `real-extension`) pass. |
| Platform matrix proof | `npm run smoke:platform:all` ([Platform smoke](PLATFORM_SMOKE.md)) | Doctor-first packed-install `platform-build` and `real-extension` (`npm run smoke:real:packed`) suites pass on `macos` and `ubuntu` on Node 24+. |
| ChatGPT preset proof (check vs produce) | `npm run release:proof:chatgpt-presets` or `npm run release:proof:chatgpt-presets:run` ([ChatGPT preset proof](#chatgpt-preset-proof)) | Live loaded-extension jobs complete and verify across all eight model presets before release or after model-selection changes. |
| Publish / release gate | `npm run release:check` ([Release gate](#release-gate)) | Local gate, offline collection proof, live ChatGPT preset proof, and the required Crabbox platform matrix pass in order. |
| Brand artwork (`assets/*.html`) | `npm run render:assets`, then `npm run render:assets -- --check` ([Brand artwork](#brand-artwork)) | Re-renders `assets/banner.png` and `assets/og.png` from `assets/*.html` and verifies dimensions and same-machine byte equality. |

## What each check covers

Use these details to decide whether a check exercises the code path you modified.

### Local gate

`npm run verify:oracle` (`npm test` is an alias) runs ten checks in order on Node `>=22.19.0`:

1. `npm run check:oracle-extension`: checks script and extension syntax (`npm run check:syntax`) and bundles `extensions/oracle/index.ts` with `esbuild`.
2. `npm run check:platform-smoke`: runs invariant checks for the local Crabbox cross-platform smoke runner ([Platform smoke](PLATFORM_SMOKE.md)) without launching containers or VMs.
3. `npm run test:oracle-helpers`: runs unit tests across `scripts/oracle-*.test.mjs`, `scripts/oracle-*.test.ts`, and `extensions/oracle/**/*.test.mjs`, including the [native `pi` status and read smoke](#native-pi-status-and-read-smoke).
4. `npm run test:site`: checks that every asset a site page references is deployed after `.github/workflows/pages.yml` stages brand assets, that staged-asset source changes trigger site redeployment, that `og:image` dimensions (`og:image:width` and `og:image:height`) match `assets/og.png` (`og.png`), and that sitemap, `robots.txt`, and canonical links agree on the site's pages.
5. `npm run test:docs`: checks that every relative Markdown link, image path, heading fragment, and GitHub link into this repository from the documentation or site resolves, and that published pages carry no maintainer workstation host names, real home directories, or numeric process ids.
6. `npm run typecheck`: typechecks the extension TypeScript project (`tsconfig.extension.json`).
7. `npm run typecheck:worker-helpers`: typechecks the shared and worker helper modules and their declarations (`tsconfig.worker-helpers.json`).
8. `npm run typecheck:worker-runtime`: typechecks the worker runtime (`tsconfig.worker-runtime.json`).
9. `npm run sanity:oracle`: runs the isolated sanity harness across config, locks, queueing, worker behavior, tool schemas, security negatives, retained source-only behavior pins, and the `README.md` preset table contract ([Sanity harness contracts](#sanity-harness-contracts)).
10. `npm run pack:check`: runs `npm pack --dry-run` to verify the published package file list.

Hosted CI runs only this local gate, on Node 24: `.github/workflows/ci.yml` on `main` and on pull requests, and `.github/workflows/release.yml` on the release tag before publishing ([Publishing](RELEASE.md#publishing)).

### Native `pi` status and read smoke

`node --test scripts/oracle-native.test.mjs` is included in `npm run test:oracle-helpers` and requires no provider credentials, network access, or dependency-baseline upgrade:

- The locally installed `pi` loads this package in an isolated persisted JSON-mode session with separate `HOME`, agent, jobs, and state directories, and any `fetch` call fails the test.
- Empty-project `/oracle-status` produces one successful display-marked `oracle-command-output` response without creating a browser job.
- Two fixture projects prove that `oracle_read`, `/oracle-status`, and `/oracle-read` refuse another project's job (`job_wrong_project`) with an error naming its owning root, return it only with that explicit `projectId` (quoted roots may contain spaces), and keep `oracle_cancel` limited to the current project.
- Production worker declarations run against fixture browser replies with real per-job locks and atomic writes: a slider reading survives a configuration failure, a picker that closes one step off Pro is reopened and stepping resumes to the target, later observations merge, and the bound research frame binds by frame id or, once its capture marker is gone, by `src`.

This check does not qualify TUI rendering, print-mode output, or live ChatGPT DOM and model selection.

### Collection proof

`npm run proof:capture` launches an owned headless Chrome or Chromium instance (auto-detected, or selected with `CHROME_BIN`) against a loopback fixture server, with no account or external network:

- Delayed composer hydration and restored-draft replacement for both the `#prompt-textarea` editor and the labeled `Ask ChatGPT` textbox, plus timeout without insertion when the replacement stays non-editable.
- Exact code payload capture, nested `<pre>` deduplication, and message-identity binding (`data-message-id` and `data-chatgpt-selection-message-id`) across shifted positional indices.
- Code blocks in live and reloaded ChatGPT shell renders and in runnable CodeMirror editor blocks: fenced in the action bar's language without treating the language label or `Run` button as prose, reading an editor block whole from its document rather than its rendered viewport rows.
- Source pills and links to other sites excluded from download candidates, generic same-origin artifact download and validation, and presigned URL query redaction in saved HTML.
- Sandboxed Deep Research report-frame collection: host-delegated native Markdown export through pre-armed download events (bytes identical to the file Chrome saved), the clickable report container excluded from download candidates, widget status counters stripped, citation pills preserved as numbered markers, diagrams without source rendered as declared gaps, and `widgetState` Markdown and references resolved into footnotes.
- Completion waiting when another client navigates the job's tab to a finished foreign conversation: no completion until the job's own turn finishes, one `navigation` lifecycle event per departure, hidden `display:none` Home `Stop` buttons ignored, and rendered offscreen `Stop` controls respected.
- Failed unbound capture writing no `response.md` and setting `recollectionNeeded`, anchored recollection through the user turn carrying the job's archive and its refusals, index-only `turnSha256` recollection across class churn, and idempotent recollection that preserves earlier bytes.
- Timed-out ChatGPT recollection waiting without saving a streaming reply, retaining the original failure on expiry, admitting another recollection, and saving the bound reply with `recollectionCompletionVerifiedAt` only after its UI completion checks. Later turns cannot substitute their text. Injected production-function tests (`oracle-recollection-{completion,boundary,atomic,read}.test.mjs` and `oracle-native-download-budget.test.mjs`) cover atomic bound capture/generation observations, snapshot Stop fallback, stability reset, empty/whitespace reloads, the exact saved capture, same-report research renderings versus mismatched/empty bodies, and unconfirmed richer exports. They also cover one absolute native-download budget, entry/lock/bootstrap deadlines, complete-job exemption, heartbeat and deadline-record drain, signal tails, durable read results after failed exits, identity replacement refusals, and one shared research wait constant. Guard-removal mutations exercise these assertions. Ordinary Grok timeout and streamed-text collection remain controls. These offline observations cannot establish whether a real reloaded provider page hides ongoing generation; validate that before release.
- Stationary control waits (`waitForStationaryControl`) without animation frames, `promptSendState` transitions (`not_sent`, `attempted`, `accepted`), fresh recollection admission timestamps, and pending-cleanup preservation across driver teardown serialization and warnings.

### Platform checks

Use the fast platform checks before launching Crabbox targets, and run the target suites when a change touches archive packing, process cleanup, runtime or browser profile handling, package metadata, or the Crabbox harness:

- `npm run verify:oracle:platform` runs `check:oracle-extension`, `check:platform-smoke`, `sanity:oracle:platform`, and `pack:check` locally without containers or SSH leases; run `npm run check:platform-smoke` or `npm run sanity:oracle:platform` individually for tighter iteration.
- `npm run smoke:platform:doctor` followed by `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` validates the affected target (`macos` or `ubuntu`) and suite (`platform-build` or `real-extension`), and `npm run smoke:platform:all` runs doctor plus both suites across `macos` and `ubuntu` on Node 24+. As configured, `--target windows-native` is rejected; see [Source of truth and targets](PLATFORM_SMOKE.md#source-of-truth-and-targets).
- `npm run smoke:real:source` loads `extensions/oracle/index.ts` directly for inner-loop source debugging and does not substitute for packed-install proof or the [isolated `pi` session smoke](#isolated-pi-session-smoke). See [Platform smoke](PLATFORM_SMOKE.md) for target setup, switches, and artifacts.

### ChatGPT preset proof

Run `npm run release:proof:chatgpt-presets:run` to submit live loaded-extension jobs for the eight model presets (`deep_research` is excluded because each run consumes a Deep Research task) and write `.artifacts/chatgpt-preset-proof/latest.json`.

Run `npm run release:proof:chatgpt-presets` to validate that file against persisted `job.json`, worker log, and response files before every release and for any change touching ChatGPT model selection or composer UI; see [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof).

### Release gate

`npm run release:check` (also run by `prepublishOnly` on a local `npm publish`) executes `npm run verify:oracle`, `npm run proof:capture`, `npm run release:proof:chatgpt-presets`, and `npm run smoke:platform:all`, in that order. It must pass on the release commit before pushing the `v*` tag that triggers trusted publishing; see [Release gate](RELEASE.md#release-gate) and [Publishing](RELEASE.md#publishing).

### Brand artwork

After editing `assets/*.html` or `assets/brand.css`, run `npm run render:assets` to re-render `assets/banner.png` and `assets/og.png`, then `npm run render:assets -- --check` to verify dimensions and same-machine byte equality without writing. See [Regeneration](BRANDING.md#regeneration) for Chrome discovery, target selection, and webfont network requirements.

## Sanity harness contracts

`npm run sanity:oracle` (`scripts/oracle-sanity.ts` and `scripts/oracle-sanity-poller-suite.ts`) enforces these harness and repository contracts in an isolated state and jobs root:

- `scripts/oracle-sanity-support.ts` is the shared fixture module for the main sanity entrypoint and poller suite: job fixtures assert `extensionProvenance` and use `transitionOracleJobPhase` lifecycle transitions, completed fixtures write `response.md` and a lifecycle event, and `shellQuote` POSIX shell quoting is verified by round-trip.
- `testOracleToolSchemas` checks the five registered TypeBox schemas, GBNF-safe non-blank patterns (`^.*[^ \t\r\n].*$`, with no `\S`), preset label aliases, and `chatGptConversationId` conversation identifiers directly, separately from source-text checks.
- The poller delivery matrix (`scripts/oracle-sanity-poller-suite.ts` and `testPollerHostSafety`) checks same-session, branched, orphaned off-session, live-target, busy, pending-message, already-notified, and past-retention contexts against delivery counts, follow-up turn options, and `notifiedAt`; when the global reconcile lock is held, a scan leaves a stale active job untouched while a terminal job's wake-up completes within two seconds.
- `testOraclePromptTemplateCutover` pin checks cover `/oracle` and `/oracle-followup` dispatch-prompt instructions, `package.json` metadata contracts, and the `README.md` preset table (every `ORACLE_SUBMIT_PRESETS` id in backticks and exact label, the only documentation wording contract in the harness).
- `testOraclePinOnlySourceContracts` pins worker and extension branches that have no behavioral test replacement; behavior covered by behavioral tests, package script strings, and `scripts/oracle-sanity-support.ts` itself are not pinned.
- `testRepoSecurityNegatives` and `testMaintainedSourcesNeverDefaultToABrowserEndpoint` scan production sources under `extensions/` (excluding `*.test.*` unit-test fixtures and allowing `extensions/oracle/shared/process-helpers.*`) for the forbidden `127.0.0.1:7328` telemetry endpoint, fixed `/tmp/oracle-auth` diagnostics paths, and duplicate `function killProcessTree` helpers, and forbid fallback loopback browser endpoints across `scripts/` and `extensions/`.

## Isolated `pi` session smoke

Use this repeatable pre-commit workflow for code changes when you need end-to-end host evidence beyond `npm test`. It validates four behaviors:

- Isolated `pi` or `omp` sessions load the local extension source directly.
- Whole-repo `oracle_submit` archive creation excludes local tool state by default.
- Targeted archive inputs cannot escape the repository through symlinked paths (`archive_input_symlink_escape`).
- Exercised agents return candid feedback about tool clarity or friction.

### Why this workflow is isolated

Each run uses separate directories for `PI_CODING_AGENT_DIR`, `--session-dir`, and `PI_ORACLE_JOBS_DIR` so validation keeps your normal agent config, session history, and job directories untouched.

The `pi` and `omp` commands in this section omit `PI_ORACLE_STATE_DIR`, so they share `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}` (admission locks, runtime leases, and `browser.maxConcurrentJobs` slots) with live sessions unless you also export `PI_ORACLE_STATE_DIR` (as [Managed browser mode](#managed-browser-mode) does).

To load the in-repo extension in `pi` rather than a globally installed package (using `$REPO`, `$TEST1_AGENT`, `$TEST1_SESSIONS`, `$TEST1_JOBS`, and `$PROMPT1` from [Repeatable smoke test](#repeatable-smoke-test)), pass `--approve --no-extensions -e`:

```bash
pi --approve --no-extensions -e "$REPO/extensions/oracle/index.ts"
```

`--approve` is intentional for this isolated workflow on `pi` `0.79+`: the test fixture is this trusted checkout, and scripted validation must not block on the project-trust prompt.

On Oh My Pi, run print mode with `--no-extensions -e` to validate the in-repo extension non-interactively:

```bash
env PI_CODING_AGENT_DIR="$TEST1_AGENT" PI_ORACLE_JOBS_DIR="$TEST1_JOBS" PI_TELEMETRY=0 \
  omp --cwd "$REPO" -p --auto-approve --session-dir "$TEST1_SESSIONS" \
  --model <model id> --thinking low --no-extensions -e "$REPO/extensions/oracle/index.ts" "$PROMPT1" < /dev/null
```

Three details govern print mode: print mode waits indefinitely on an open piped stdin (`readPipedInput`), so close stdin with `< /dev/null`; `oracle_submit` refuses `--no-session`, so keep a persisted `--session-dir`; and the isolated `PI_CODING_AGENT_DIR` carries no model configuration, so copy a `models.yml` for the chosen model into it (a zero-cost local model works).

`npm run release:proof:chatgpt-presets:run` automates that print-mode route with an isolated `PI_ORACLE_STATE_DIR` for the release preset proof.

The local extension intercepts TUI `/oracle` and `/oracle-followup` before prompt-template expansion, re-injects the compact slash request as the visible user message for prompt-history and up-arrow recall, and reads the in-repo prompt files as hidden dispatch instructions, so do not pass `--prompt-template` for normal local-extension validation. In print, JSON, and RPC modes, the extension contributes the prompt templates itself.

Do not add this repository's GitHub URL to `.pi/settings.json` to test local changes. Mixing a project-local git package with a globally installed upstream `npm:pi-oracle` or published `omp-oracle` creates two distinct package identities and can trigger prompt or tool conflicts; pass the explicit `-e` CLI flag instead.

`oracle_submit` preflights missing, unreadable, or unverified auth seed profiles before it creates an archive or persists a job. For archive-inspection smoke tests that intentionally run without real provider auth, use `oracle_preflight` for the blocker path or create a test seed only in a purpose-built fixture with a non-empty timestamped `.oracle-seed-generation` marker.

### Preset choice

For pre-commit isolated smoke tests, use `instant` or `thinking_light`. The examples below use `instant` because it is the fastest smoke-test preset; to switch to `thinking_light`, replace `preset "instant"` with `preset "thinking_light"` in both prompts. Changes that touch ChatGPT model selection or UI, and every release, require the live eight-preset proof instead ([ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof)).

### Repeatable smoke test

Ensure `pi`, `tmux`, `tar`, `zstd`, `python3`, and `agent-browser` (`0.41.2`+) are on `PATH`, provide `pi` model credentials in the environment (or inside `$TEST1_AGENT` and `$TEST2_AGENT`), and run from the repository root while at least one slot is free in `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}` (or add `PI_ORACLE_STATE_DIR='$TEST_ROOT/state'` to both `TMUX_CMD` strings).

Before starting `tmux`, the script writes a timestamped `.oracle-seed-generation` file into each isolated `oracle-auth-seed-profile` directory without running `/oracle-auth`: an empty (`touch`) or missing marker is rejected before archiving, whereas a non-empty marker lets `TEST1` build the archive on disk (its worker fails later for lack of real cookies) and lets `TEST2` reach archive-input symlink validation.

Run the script below to launch two isolated `pi` sessions in `tmux`, testing whole-repo archive default exclusions (`TEST1`) and symlink-escape rejection (`TEST2`):

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-isolated-tests-$$"

TEST1_AGENT="$TEST_ROOT/agent1"
TEST1_SESSIONS="$TEST_ROOT/sessions1"
TEST1_JOBS="$TEST_ROOT/jobs1"
TEST2_AGENT="$TEST_ROOT/agent2"
TEST2_SESSIONS="$TEST_ROOT/sessions2"
TEST2_JOBS="$TEST_ROOT/jobs2"

FIXTURE="$TEST_ROOT/symlink-fixture"
OUTSIDE="$TEST_ROOT/outside"

SESSION1="pi-oracle-test1"
SESSION2="pi-oracle-test2"

mkdir -p \
  "$TEST1_AGENT" "$TEST1_SESSIONS" "$TEST1_JOBS" \
  "$TEST2_AGENT" "$TEST2_SESSIONS" "$TEST2_JOBS" \
  "$FIXTURE" "$OUTSIDE"

mkdir -p \
  "$TEST1_AGENT/extensions/oracle-auth-seed-profile" \
  "$TEST2_AGENT/extensions/oracle-auth-seed-profile"
date -u +%FT%TZ > "$TEST1_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation"
date -u +%FT%TZ > "$TEST2_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation"

echo 'secret' > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE" "$FIXTURE/linked-outside"

PROMPT1='Call oracle_submit directly with prompt "Sanity test for archive exclusions. Reply with OK." files ["."] and preset "instant". Do not use bash. After the tool returns, summarize the outcome in 3 bullets including the job id/status, and give one sentence of candid feedback on whether the oracle tool behavior feels clear or clunky.'
PROMPT2='Call oracle_submit directly with prompt "Sanity test for symlink escape rejection." files ["linked-outside/secret.txt"] and preset "instant". Do not use bash. After the tool returns, summarize the outcome in 3 bullets and give one sentence of candid feedback on whether the oracle tool behavior feels clear or clunky.'

cleanup() {
  tmux kill-session -t "$SESSION1" 2>/dev/null || true
  tmux kill-session -t "$SESSION2" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' pi --approve --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
tmux new-session -d -s "$SESSION1" "$TMUX_CMD1"
sleep 8
tmux send-keys -t "$SESSION1":0.0 "$PROMPT1" Enter
sleep 35

echo '--- pane:test1'
tmux capture-pane -p -S -220 -t "$SESSION1":0.0 | tail -n 160

JOB_DIR1="$(find "$TEST1_JOBS" -maxdepth 1 -type d -name 'oracle-*' | sort | tail -n 1 || true)"
echo "--- latest job dir:test1 ${JOB_DIR1:-<none>}"

if [ -n "${JOB_DIR1:-}" ] && [ -f "$JOB_DIR1/job.json" ]; then
  ARCHIVE1="$(python3 - <<'PY' "$JOB_DIR1/job.json"
import json,sys
with open(sys.argv[1]) as f:
    print(json.load(f)['archivePath'])
PY
)"
  echo "--- archive:test1 $ARCHIVE1"
  tar --zstd -tf "$ARCHIVE1" | head -n 80
  LIST="$(mktemp)"
  tar --zstd -tf "$ARCHIVE1" > "$LIST"
  for path in .pi/settings.json .oracle-context .cursor .scratchpad.md README.md; do
    if grep -E -q "^${path}$|^${path}/" "$LIST"; then
      echo "FOUND $path"
    else
      echo "MISSING $path"
    fi
  done
  rm -f "$LIST"
fi

TMUX_CMD2="cd '$FIXTURE' && env PI_CODING_AGENT_DIR='$TEST2_AGENT' PI_ORACLE_JOBS_DIR='$TEST2_JOBS' PATH='$PATH' pi --approve --session-dir '$TEST2_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
tmux new-session -d -s "$SESSION2" "$TMUX_CMD2"
sleep 8
tmux send-keys -t "$SESSION2":0.0 "$PROMPT2" Enter
sleep 25

echo '--- pane:test2'
tmux capture-pane -p -S -220 -t "$SESSION2":0.0 | tail -n 160

echo '--- jobs created:test2'
find "$TEST2_JOBS" -maxdepth 1 -type d -name 'oracle-*' | sort || true

echo "TEST_ROOT=$TEST_ROOT"
```

### Expected observations

Confirm both sessions match these outcomes before removing `$TEST_ROOT`:

#### Test 1: whole-repo archive default exclusions

- The isolated `pi` session loads the local extension and `oracle_submit` creates a job and archive path under `$TEST1_JOBS` (while the detached worker fails afterwards because the marker-only seed holds no provider cookies).
- The submit response forbids polling, describes the one-time completion wake-up in the submitting session, and names `oracle_read` with that job's `jobId` for user-requested status checks (`sanity:oracle` covers both dispatched and queued responses).
- Expanding `.` excludes `.pi/settings.json`, `.oracle-context`, `.cursor`, and `.scratchpad.md` (`MISSING`), and includes normal repository files such as `README.md` (`FOUND`).

#### Test 2: symlink escape rejection

- `oracle_submit` rejects `linked-outside/secret.txt` (`archive_input_symlink_escape`) with `Archive input must resolve inside the project cwd without symlink escapes: linked-outside/secret.txt`.
- No `oracle-*` job directory is created under `$TEST2_JOBS` for the rejected submission.

### Testing local `/oracle` command-prompt changes

The repeatable script above calls `oracle_submit` directly. When you modify `prompts/oracle.md` or `prompts/oracle-followup.md`, substitute `TMUX_CMD1` below into the repeatable script and send `/oracle <request>` (or `/oracle-followup <job-id> <request>` against a completed job in `$TEST1_JOBS`) instead of `$PROMPT1`, so the extension reads the in-repo prompt file as hidden dispatch instructions:

```bash
LOCAL_ORACLE_PI_CMD="pi --approve --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' $LOCAL_ORACLE_PI_CMD"
```

`/oracle` starts by calling `oracle_preflight`. To proceed past that guard in an isolated test without touching your normal auth seed, create a purpose-built seed fixture with a non-empty `.oracle-seed-generation` marker, or run `/oracle-auth` inside the isolated `PI_CODING_AGENT_DIR` (setting `PI_ORACLE_STATE_DIR` too if you do not want `/oracle-auth` to take the auth lock in `/tmp/pi-oracle-state`).

### Cleanup and minimum pre-commit evidence

The script kills the temporary `tmux` sessions on exit. After inspecting the output, remove the temporary directory printed as `TEST_ROOT=...` at the end of the run:

```bash
rm -rf "$TEST_ROOT"
```

Before committing code changes, keep evidence for:

- `npm run verify:oracle` (`npm test`) passing;
- isolated `pi` session validation using this workflow;
- any agent feedback gathered during the isolated run if it exposed clunky or unclear behavior.

## Focused failure-mode and managed-browser checks

Run these targeted checks when changing auth bootstrap timeouts, process teardown, or managed-browser lifecycle code.

### `/oracle-auth` timeout when `agent-browser` hangs

Use this check when modifying timeout or process-cleanup handling around auth and bootstrap browser commands. The script points `auth.chromeCookiePath` at a cookie database that does not exist and installs a fake `agent-browser` that answers the version check and then sleeps on every other command. It verifies that `/oracle-auth` fails within the configured timeouts instead of hanging the session:

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-auth-timeout-$$"
AGENT_DIR="$TEST_ROOT/agent"
SESSION_DIR="$TEST_ROOT/sessions"
JOBS_DIR="$TEST_ROOT/jobs"
STATE_DIR="$TEST_ROOT/state"
# The cookie database gets its own directory: Oracle treats that tree as a browser
# profile root and rejects a config whose auth seed profile sits inside it.
COOKIE_DB="$TEST_ROOT/browser-profile/Default/Cookies"
FAKE_BROWSER="$TEST_ROOT/agent-browser"
SESSION_NAME="pi-oracle-auth-timeout"

mkdir -p "$AGENT_DIR/extensions" "$SESSION_DIR" "$JOBS_DIR" "$STATE_DIR"

cat > "$AGENT_DIR/extensions/oracle.json" <<JSON
{
  "auth": {
    "chromeCookiePath": "$COOKIE_DB"
  }
}
JSON

# The auth worker checks the driver version first, so the fake answers that and hangs on the rest.
cat > "$FAKE_BROWSER" <<'SH'
#!/bin/sh
if [ "$1" = "--version" ]; then echo 'agent-browser 0.41.2'; exit 0; fi
trap 'exit 0' TERM INT
while :; do sleep 1; done
SH
chmod +x "$FAKE_BROWSER"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}
trap 'cleanup; rm -rf "$TEST_ROOT"' EXIT
cleanup

TMUX_CMD="cd '$REPO' && env PI_CODING_AGENT_DIR='$AGENT_DIR' PI_ORACLE_JOBS_DIR='$JOBS_DIR' PI_ORACLE_STATE_DIR='$STATE_DIR' AGENT_BROWSER_PATH='$FAKE_BROWSER' PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS='250' PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS='250' PI_ORACLE_AUTH_KILL_GRACE_MS='100' PATH='$PATH' pi --approve --session-dir '$SESSION_DIR' --no-extensions -e '$REPO/extensions/oracle/index.ts'"

# A wide, tall pane keeps the whole failure message in the captured screen.
tmux new-session -d -s "$SESSION_NAME" -x 200 -y 60 "$TMUX_CMD"
sleep 8
tmux send-keys -t "$SESSION_NAME":0.0 '/oracle-auth' Enter
sleep 12

tmux capture-pane -p -S -220 -t "$SESSION_NAME":0.0 | tail -n 140
```

Expected observations:

- The isolated `pi` session loads the local extension.
- `/oracle-auth` returns an error within the timeout instead of hanging.
- The output reports `Oracle auth failed.` with the reason `No ChatGPT session-token cookies were found in Chrome cookie DB <path>`, and names the `pi-oracle-auth-*` diagnostics directory.
- The `pi` session stays responsive after the command fails, and its footer shows `oracle: auth needed`.

### Managed browser mode

Changes that touch `browser.chatGptManagedProfileDir` (launch, attach, keeper, sign-in, or readiness; see [Managed browser transport](ARCHITECTURE.md#managed-browser-transport)) require a run in managed-browser mode through Oh My Pi print mode.

The command below gives the session an isolated `PI_ORACLE_STATE_DIR` (holding `managed-browser.log` and the profile lock) and a 15-second idle grace (`PI_ORACLE_MANAGED_BROWSER_IDLE_MS=15000`) for the detached keeper process (`managed-browser.mjs`) that launches Chrome and quits it when idle, validating launch, attach, per-command browser-identity checks, and idle shutdown without spending a ChatGPT response:

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-managed-tests-$$"
AGENT="$TEST_ROOT/agent"
PROFILE="$TEST_ROOT/managed-profile"

mkdir -p "$AGENT/extensions" "$TEST_ROOT/sessions" "$TEST_ROOT/jobs" "$TEST_ROOT/state" "$PROFILE"
cp "<models.yml for the chosen model>" "$AGENT/models.yml"
printf '{"browser":{"chatGptManagedProfileDir":"%s","args":["--disable-sync"]}}\n' "$PROFILE" > "$AGENT/extensions/oracle.json"

PROMPT='Call oracle_preflight once for ChatGPT, then oracle_submit exactly once with prompt "Reply with exactly: MANAGED OK", files ["README.md"], preset "instant". Do not use bash. Report both results and one sentence of candid feedback on anything unclear or clunky.'
env PI_CODING_AGENT_DIR="$AGENT" PI_ORACLE_JOBS_DIR="$TEST_ROOT/jobs" PI_ORACLE_STATE_DIR="$TEST_ROOT/state" \
  PI_ORACLE_MANAGED_BROWSER_IDLE_MS=15000 PI_TELEMETRY=0 \
  omp --cwd "$REPO" -p --auto-approve --session-dir "$TEST_ROOT/sessions" \
  --model <model id> --thinking low --no-extensions -e "$REPO/extensions/oracle/index.ts" "$PROMPT" < /dev/null
```

Expected observations for the unsigned profile: the empty profile is not signed in, so the job fails at `verifying_auth` and asks you to rerun `/oracle-auth`. Running `oracle_auth` the same way opens a ChatGPT sign-in tab and reports that a person must sign in; close that tab afterwards, or the keeper leaves Chrome open for it.

For a signed-in run on macOS, never point the test session at a profile whose Chrome is serving live jobs, such as the Chrome behind your relay endpoint. Clone that profile into `$PROFILE` with `cp -c -R` (use `cp -R` on Linux), remove its singleton lock files, mark it cleanly exited, and re-run the `omp` command above against `$PROFILE`:

```bash
SIGNED_IN_PROFILE="<signed-in Chrome user-data directory>"
rm -rf "$PROFILE"
cp -c -R "$SIGNED_IN_PROFILE" "$PROFILE"
# The live holder's singleton files would hand the launch to the running Chrome.
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie} "$PROFILE/DevToolsActivePort"
# A managed launch starts from a cleanly quit profile.
node -e 'const fs = require("fs"), f = process.argv[1], p = JSON.parse(fs.readFileSync(f, "utf8")); p.profile = { ...p.profile, exit_type: "Normal", exited_cleanly: true }; fs.writeFileSync(f, JSON.stringify(p));' "$PROFILE/Default/Preferences"
```

The clone's cookies stay encrypted with this Mac's Chrome Safe Storage key, so it signs in only with the same Chrome on the same machine, and `--disable-sync` in the config keeps it from syncing as the live profile's Chrome client. Delete `$TEST_ROOT` afterwards because the clone holds session cookies.

Expected observations for the signed-in profile:

- The worker log shows `Opened the managed ChatGPT browser at http://127.0.0.1:<port>` (`Reusing …` when a Chrome started with `--remote-debugging-port=0` already serves the profile), and `job.json` records `endpoint` and `browserUrl` under `managedBrowser`.
- The signed-in job completes with `MANAGED OK` and no cleanup warnings.
- `$TEST_ROOT/state/managed-browser.log` shows `started Chrome`, then, about 15 seconds after the last job and page close, `quit Chrome … with no job and no page` and `exited (exit code 0)`.
- `agent-browser session list` does not list the `runtimeSessionName` recorded in `job.json` after teardown.

## Auth recovery drill

Use this maintainer drill to validate missing or unauthenticated auth seed profile detection and `/oracle-auth` recovery on the isolated seed profile transport:

1. An empty or unauthenticated auth seed profile is refused at submission before creating an archive or job.
2. The blocker is reported as an auth seed readiness failure, not as generic UI drift.
3. `/oracle-auth` repairs the auth seed profile without touching your real Chrome profile.
4. The next oracle job completes cleanly.

### Safety guarantees and preconditions

Confirm both safety boundaries and preconditions before modifying `SEED`:

- Safety boundary: this drill mutates only the isolated auth seed profile configured by `browser.authSeedProfileDir` (`<agent-dir>/extensions/oracle-auth-seed-profile` by default). Never point `SEED` at your real Chrome user-data directory.
- Preconditions: no active oracle jobs, `pi` reloaded with the current extension code, and `/oracle-auth` verified to work in the current environment.

### 1. Back up the current seed profile

Copy the isolated auth seed profile before mutating it so you can restore it if recovery fails (use `cp -R` instead of `cp -cR` on Linux):

```bash
SEED="<oracle-auth-seed-profile-dir>"
BACKUP="/tmp/oracle-auth-seed-backup-$(date +%Y%m%dT%H%M%S)"
cp -cR "$SEED" "$BACKUP"
echo "$BACKUP"
```

Confirm `echo "$BACKUP"` prints a non-empty backup directory path.

### 2. Simulate an unauthenticated seed profile

Replace the seed directory with an empty `0700` directory containing no `.oracle-seed-generation` marker:

```bash
SEED="<oracle-auth-seed-profile-dir>"
rm -rf "$SEED"
mkdir -p "$SEED"
chmod 700 "$SEED"
```

### 3. Verify submission refusal

1. Restart `pi` so the extension reads the empty seed directory state.
2. Run `oracle_preflight` or attempt a small `oracle_submit` call.

Expected observations:

- `oracle_submit` refuses the submission before creating an archive or persisting a job directory with `Oracle auth seed profile exists but is not authenticated: <dir>. Run /oracle-auth to create a verified auth seed before submitting oracle jobs.` (or, if `<dir>` was removed and not recreated, `Oracle auth seed profile not found: <dir>. Run /oracle-auth first.`).
- `oracle_preflight` reports the same auth seed blocker.
- The refusal is not misclassified as a model configuration failure, artifact failure, generic timeout, or UI drift.

### 4. Repair with `/oracle-auth` and rerun

1. Run `/oracle-auth` in the host session:

   ```text
   /oracle-auth
   ```

   Expected: provider cookies sync into the isolated seed profile, `.oracle-seed-generation` is written, your real Chrome profile stays untouched, and `/oracle-auth` prints its diagnostics directory path and reports success.

2. Reload `pi` after auth repair.
3. Submit the same small oracle job again.

   Expected: the job completes, writes `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/response.md`, and delivers the session wake-up.

### Pass criteria and evidence to capture

The drill passes when all three criteria hold:

- The unauthenticated seed directory is refused at preflight and submission with the exact auth seed message above.
- `/oracle-auth` repairs the seed profile cleanly without mutating your real Chrome profile.
- The subsequent oracle job completes with no worker, session, or profile cleanup warnings.

Capture as evidence:

- Refusal step: the exact `oracle_preflight` or `oracle_submit` refusal text (no `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` directory is created because submission stops before archiving or job creation).
- Repair step: the `pi-oracle-auth-*` diagnostics directory under the system temporary directory — use the exact path `/oracle-auth` prints — containing `oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, `oracle-auth.body.txt`, and `oracle-auth.png` (when a screenshot was taken).
- Completed rerun: `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/job.json`, `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/response.md`, and `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/logs/worker.log`.

### Maintainer note and failure handling

This is a maintainer validation procedure that intentionally replaces the isolated auth seed profile, not end-user setup documentation:

- If the unauthenticated seed step is not refused with the auth seed blocker message, fix seed readiness checks before treating recovery as working.
- If `/oracle-auth` fails to restore a working seed, remove the empty `"$SEED"` directory and copy `"$BACKUP"` back to `"$SEED"` (`rm -rf "$SEED" && cp -R "$BACKUP" "$SEED"`), then treat auth recovery as blocking.
