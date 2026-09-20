# OMP Oracle test plan

The validation ladder for `omp-oracle`, cheapest first. Run the narrowest rung that answers
the question; the full gate lives in [Release](RELEASE.md).

| Rung | Command or procedure | Proves |
| --- | --- | --- |
| Local gate | `npm run verify:oracle` | Syntax and bundle checks, helper unit tests, both typechecks, the isolated sanity harness (config, locks, queueing, worker, tool schemas, documentation contracts), and `npm pack --dry-run` |
| Isolated `pi` session smoke | [below](#isolated-pi-session-smoke) | The local extension loads through the real `pi` CLI; whole-repo archives exclude local tool state; symlink escapes are rejected; exercised agents give candid feedback |
| Auth recovery drill | [below](#auth-recovery-drill) | A broken auth seed fails as a clean auth error, `/oracle-auth` repairs it, and the next job succeeds |
| Platform matrix | [`docs/PLATFORM_SMOKE.md`](PLATFORM_SMOKE.md) | Packed install, load, and `oracle_submit` on macOS and Ubuntu through Crabbox (Windows native available, not required) |
| ChatGPT preset proof | `npm run release:proof:chatgpt-presets` | Fresh loaded-extension jobs for every canonical preset |

Companion docs: [Architecture](ARCHITECTURE.md) · [Operations](OPERATIONS.md) ·
[Release](RELEASE.md)

## Isolated `pi` session smoke

This section describes the repeatable pre-commit smoke test for validating `omp-oracle` through isolated `pi` agent sessions that load the local extension source.

Use this workflow for code changes when you need end-to-end evidence beyond `npm test`.

### What this validates

- the local extension can be loaded directly by isolated `pi` sessions
- whole-repo `oracle_submit` archive creation excludes local tool state by default
- targeted archive inputs cannot escape the repo through symlinked paths
- the exercised `pi` agents can provide candid feedback about tool clarity or clunkiness

### Why this workflow is isolated

The test intentionally uses separate directories for:

- `PI_CODING_AGENT_DIR`
- `--session-dir`
- `PI_ORACLE_JOBS_DIR`

That keeps the validation run from reusing your normal `pi` agent state.

The extension is loaded from the local checkout with:

```bash
pi --approve --no-extensions -e "$REPO/extensions/oracle/index.ts"
```

That ensures the session is exercising the in-repo code, not a globally installed package. `--approve` is intentional for this isolated workflow on Pi 0.79+: the test fixture is this trusted checkout, and non-interactive/scripted validation must not block on the project-trust prompt.

The local extension now intercepts TUI `/oracle` and `/oracle-followup` before prompt-template expansion, re-injects the compact slash request as the visible user message for prompt-history/up-arrow recall, and reads the in-repo prompt files as hidden dispatch instructions, so do not pass `--prompt-template` for normal local-extension validation. In print/json/rpc modes, the extension contributes the prompt templates itself.

Do not add this repository's GitHub URL to `.pi/settings.json` just to test local oracle changes. If you already keep upstream `npm:pi-oracle` or a published `omp-oracle` installed globally, mixing that package with a project-local git package creates two distinct package identities and can trigger prompt/tool conflicts. Use the explicit CLI extension flag above instead.

`oracle_submit` now preflights missing, unreadable, or unverified auth seed profiles before it creates an archive or persists a job. For archive-inspection smoke tests that intentionally run without real auth, use `oracle_preflight` for the blocker path or create a test seed only in a purpose-built fixture that includes the `.oracle-seed-generation` marker.

### Preset requirements

For ordinary pre-commit isolated smoke tests, use either:

- `instant`
- `thinking_light`

The examples below use `instant` because it is the fastest smoke-test preset.

For any release, and for any change that touches ChatGPT model selection, run live loaded-extension jobs for every canonical ChatGPT preset from `ORACLE_SUBMIT_PRESETS`:

- `pro_standard`
- `pro_extended`
- `thinking_light`
- `thinking_standard`
- `thinking_extended`
- `thinking_heavy`
- `instant`
- `instant_auto_switch`

Use prompts that make each saved response contain exact markers `PRESET <preset> OK` and `PACKAGE omp-oracle`. Save the completed job ids/job directories in `.artifacts/chatgpt-preset-proof/latest.json` only after every job completes; `validatedAt` must be later than those completed jobs. The checker reads the actual persisted `job.json`, worker log, and response files. Then run:

```bash
npm run release:proof:chatgpt-presets
```

`npm run release:check` runs that proof gate before release. This is intentional: publishing is blocked until every ChatGPT preset has fresh loaded-extension evidence.

### Prerequisites

- `pi` installed locally
- `tmux` installed locally
- run from the repository root

### Repeatable smoke test

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
touch \
  "$TEST1_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation" \
  "$TEST2_AGENT/extensions/oracle-auth-seed-profile/.oracle-seed-generation"

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

### Expected results

#### Test 1: whole-repo archive exclusions

Expected behavior:

- the isolated `pi` session loads the local extension successfully
- `oracle_submit` creates a job and an archive path under the isolated jobs dir
- the archive should exclude:
  - `.pi/`
  - `.oracle-context/`
  - `.cursor/`
  - `.scratchpad.md`
- the archive should still include normal repo files such as `README.md`

Notes:

- this smoke test does not require `/oracle-auth`
- the snippet creates an isolated test auth seed profile plus `.oracle-seed-generation` marker for `TEST1_AGENT` because `oracle_submit` now rejects missing or unverified seed profiles before archiving
- with that marker-only seed profile, the worker still fails later due to missing real auth, which is useful because the archive remains on disk for inspection

#### Test 2: symlink escape rejection

Expected behavior:

- `oracle_submit` rejects `linked-outside/secret.txt`
- the snippet creates the same marker-only isolated auth seed profile for `TEST2_AGENT` so the test reaches archive input validation
- the error should say the archive input must resolve inside the project cwd without symlink escapes
- no oracle job directory should be created for the rejected submit

### Testing local `/oracle` command-prompt changes too

The main smoke test above calls `oracle_submit` directly, so it only needs the local extension entrypoint. If you also changed `prompts/oracle.md`, start the isolated session with the same local extension entrypoint; the extension reads the in-repo prompt file as hidden command-dispatch instructions:

```bash
LOCAL_ORACLE_PI_CMD="pi --approve --session-dir '$TEST1_SESSIONS' --no-extensions -e '$REPO/extensions/oracle/index.ts'"
TMUX_CMD1="cd '$REPO' && env PI_CODING_AGENT_DIR='$TEST1_AGENT' PI_ORACLE_JOBS_DIR='$TEST1_JOBS' PATH='$PATH' $LOCAL_ORACLE_PI_CMD"
```

Use the same pattern for additional sessions, swapping the session/job directories as needed. This keeps the test on the in-repo extension and hidden in-repo command prompt without depending on `.pi/settings.json` package entries.

`/oracle` now starts by calling `oracle_preflight`. If you want the command flow to proceed past that early guard in an isolated test without using your normal auth state, run `/oracle-auth` in the isolated agent dir or create a purpose-built verified seed fixture with `.oracle-seed-generation`.

### Additional failure-mode smoke tests

#### `/oracle-auth` should fail fast when `agent-browser` hangs

Use this when validating timeout hardening around auth/bootstrap browser commands.

```bash
set -euo pipefail

REPO="$PWD"
TEST_ROOT="/tmp/pi-oracle-auth-timeout-$$"
AGENT_DIR="$TEST_ROOT/agent"
SESSION_DIR="$TEST_ROOT/sessions"
JOBS_DIR="$TEST_ROOT/jobs"
FAKE_BROWSER="$TEST_ROOT/agent-browser"
SESSION_NAME="pi-oracle-auth-timeout"

mkdir -p "$AGENT_DIR/extensions" "$SESSION_DIR" "$JOBS_DIR"

cat > "$AGENT_DIR/extensions/oracle.json" <<JSON
{
  "auth": {
    "chromeCookiePath": "$TEST_ROOT/missing-cookies.sqlite"
  }
}
JSON

cat > "$FAKE_BROWSER" <<'SH'
#!/bin/sh
trap 'exit 0' TERM INT
while :; do sleep 1; done
SH
chmod +x "$FAKE_BROWSER"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}
trap 'cleanup; rm -rf "$TEST_ROOT"' EXIT
cleanup

TMUX_CMD="cd '$REPO' && env PI_CODING_AGENT_DIR='$AGENT_DIR' PI_ORACLE_JOBS_DIR='$JOBS_DIR' AGENT_BROWSER_PATH='$FAKE_BROWSER' PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS='250' PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS='250' PI_ORACLE_AUTH_KILL_GRACE_MS='100' PATH='$PATH' pi --approve --session-dir '$SESSION_DIR' --no-extensions -e '$REPO/extensions/oracle/index.ts'"

tmux new-session -d -s "$SESSION_NAME" "$TMUX_CMD"
sleep 8
tmux send-keys -t "$SESSION_NAME":0.0 '/oracle-auth' Enter
sleep 12

tmux capture-pane -p -S -220 -t "$SESSION_NAME":0.0 | tail -n 140
```

Expected behavior:

- the isolated `pi` session loads the local extension successfully
- `/oracle-auth` returns with an error instead of hanging indefinitely
- the output should mention the missing ChatGPT session-token cookies or the configured cookie source problem
- the session should remain usable after the command failure

### Switching to `thinking_light`

To run the same smoke test with `thinking_light`, change both prompts from:

```text
preset "instant"
```

to:

```text
preset "thinking_light"
```

### Cleanup

The snippet already kills the temporary `tmux` sessions on exit.

To remove the temporary files after inspection:

```bash
rm -rf "$TEST_ROOT"
```

### Minimum pre-commit evidence

Before committing code changes, keep evidence for:

- `npm test` passing
- isolated `pi` session validation using this workflow
- any agent feedback gathered during the isolated run if it exposed clunky or unclear behavior

## Auth recovery drill

This section codifies the safe validation drill for expired / missing auth in the isolated oracle seed profile.

The goal is to prove:
1. a broken seed profile fails cleanly
2. the failure is classified as auth/login-required, not as generic UI drift
3. `/oracle-auth` repairs the seed profile
4. the next normal oracle job succeeds again

### Safety guarantees

This drill must **not** touch the user’s real Chrome profile.
It only mutates the isolated oracle seed profile configured by `browser.authSeedProfileDir`.

That directory must remain separate from the real Chrome user-data tree.

### Preconditions

- No active oracle jobs
- `pi` reloaded with the current extension code
- `/oracle-auth` happy path already known to work in the current environment

### Backup

Create a backup of the current seed profile first:

```bash
SEED="<oracle-auth-seed-profile-dir>"
BACKUP="/tmp/oracle-auth-seed-backup-$(date +%Y%m%dT%H%M%S)"
cp -cR "$SEED" "$BACKUP"
echo "$BACKUP"
```

### Expired/missing-auth simulation

Replace the seed profile with an empty isolated directory:

```bash
SEED="<oracle-auth-seed-profile-dir>"
rm -rf "$SEED"
mkdir -p "$SEED"
chmod 700 "$SEED"
```

This simulates a seed profile with no usable provider session.

### Validation steps

#### 1. Reload `pi`

Reload so the extension sees the current seed directory state.

#### 2. Run a tiny oracle job

Use a tiny prompt with a tiny archive.
Expected result:
- job fails quickly
- failure is clearly auth/login related
- failure is **not** misclassified as:
  - model configuration failure
  - artifact failure
  - generic timeout
  - vague UI drift

#### 3. Repair with `/oracle-auth`

Run:

```text
/oracle-auth
```

Expected result:
- provider cookies are re-synced into the seed profile
- no real Chrome profile is mutated
- command reports success

#### 4. Reload `pi` again

Reload after auth repair.

#### 5. Run the same tiny oracle job again

Expected result:
- job succeeds normally
- response persists under `/tmp/oracle-<job-id>/response.md`
- wake-up triggers correctly

### Pass criteria

The drill passes only if all of the following are true:

- Broken seed profile fails as an auth/login-required problem
- `/oracle-auth` repairs the seed profile cleanly
- The next normal oracle run succeeds
- No active worker/session/profile cleanup regressions appear
- No interaction with the real Chrome profile is required beyond cookie sync during `/oracle-auth`

### Evidence to capture

For the failed run:
- `/tmp/oracle-<job-id>/job.json`
- `/tmp/oracle-<job-id>/logs/worker.log`
- any failure diagnostics under that job dir

For the repair:
- the per-run `/tmp/pi-oracle-auth-*/` diagnostics directory printed by `/oracle-auth`
- `oracle-auth.log`
- `oracle-auth.url.txt`
- `oracle-auth.snapshot.txt`
- `oracle-auth.body.txt`

For the successful rerun:
- `/tmp/oracle-<job-id>/job.json`
- `/tmp/oracle-<job-id>/response.md`
- `/tmp/oracle-<job-id>/logs/worker.log`

### Maintainer note

This is a maintainer/operator validation document, not end-user setup documentation.
It intentionally includes destructive steps against the isolated oracle seed profile only.

### If the drill fails

If the broken-seed run fails with anything other than a clean auth classification, fix that before treating recovery as production-ready.

If `/oracle-auth` does not restore a working seed, treat auth recovery as still blocking.
