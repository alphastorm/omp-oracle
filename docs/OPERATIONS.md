# OMP Oracle operations

Configuration, auth transports, cookie sources, job outputs, retention, and troubleshooting for
`omp-oracle`. [Architecture](ARCHITECTURE.md) explains why the pieces exist; this page explains
how to run them.

Companion docs: [Security model](SECURITY.md) · [Compatibility](COMPATIBILITY.md) ·
[Test plan](TEST_PLAN.md)

## Config files

| Scope | Oh My Pi | `pi` | May set |
| --- | --- | --- | --- |
| Agent (global) | `~/.omp/agent/extensions/oracle.json` | `~/.pi/agent/extensions/oracle.json` | everything, including `browser.*` and `auth.*` |
| Project | `.omp/extensions/oracle.json` | `.pi/extensions/oracle.json` | `defaults`, `worker`, `poller`, `artifacts`, `cleanup` only |

The paths are the host's agent directory and config directory name plus `extensions/oracle.json`.
A project file that names any other top-level key is rejected; browser paths, cookie sources,
keychain items, and the relay endpoint come only from the agent-level file because they control
local browser state.

Pi 0.79+ gates project-local inputs behind project trust. `omp-oracle` keeps the upstream risk-on
behavior for this package-specific safe override file: it loads by default for compatibility and
is ignored when you explicitly opt out with `--no-approve` or save a "do not trust" decision for
the project. On OMP hosts without Pi's project-trust exports, project overrides require an
explicit host trust decision or approval flag; config-only callers default to agent
configuration.

Most users need no config. Set the agent-level file only for a non-default provider, preset,
mode, browser profile, or transport:

```json
{
  "defaults": {
    "provider": "chatgpt",
    "preset": "<preset id from ORACLE_SUBMIT_PRESETS>",
    "grokMode": "heavy"
  },
  "auth": {
    "chromeProfile": "Default"
  }
}
```

- `defaults.provider` — `chatgpt` or `grok`.
- `defaults.preset` — default ChatGPT preset. Canonical ids live in
  [`extensions/oracle/lib/config.ts`](../extensions/oracle/lib/config.ts); omit it to use the
  packaged default.
- `defaults.grokMode` — only `heavy` is supported today.
- Browser paths are auto-detected. Set `browser.executablePath` only when detection fails or you
  use a non-default Chromium-family browser.

The full shape, including `browser.*`, `auth.*`, `worker.*`, `poller.*`, `artifacts.*`, and
`cleanup.*` defaults, is in [Architecture → Config files](ARCHITECTURE.md#config-files).

## Auth transports

### Isolated seed profile (default)

`/oracle-auth [chatgpt|grok]` reads the provider's cookies from your configured local browser
profile in read-only mode and writes them into an isolated seed profile at
`browser.authSeedProfileDir` (default `<agent dir>/extensions/oracle-auth-seed-profile`). Each
job clones that seed into its own runtime profile under `browser.runtimeProfilesDir` (default: the
sibling `oracle-runtime-profiles` directory), runs headless by default (`browser.runMode`), and
deletes the clone when it finishes. Up to `browser.maxConcurrentJobs` (default 2) run at once;
the rest queue.

Run `/oracle-auth` once per provider and again whenever a job reports that login is required.
`/oracle-auth grok` force-refreshes the Grok seed when ChatGPT remains the default provider.
Agent callers can use `oracle_auth({})` once before retrying a stale-auth submission.

Each run writes diagnostics to a private per-run directory and prints the path:
`/tmp/pi-oracle-auth-*/` containing `oracle-auth.log`, `oracle-auth.url.txt`,
`oracle-auth.snapshot.txt`, and `oracle-auth.body.txt`.

### Existing-Chrome relay (ChatGPT only)

To use your signed-in Chrome session instead of copying cookies, set the agent-level browser
option:

```json
{ "browser": { "chatGptRelayEndpoint": "http://127.0.0.1:9224" } }
```

- The relay must expose CDP target discovery (`Target.getTargets`), creation, attachment, and
  closure. Older OMP relay builds without `Target.getTargets` cannot serve `agent-browser`; use
  `agent-browser` 0.35.0 or newer with pinned-tab support.
- The option cannot be set from project config and applies only to ChatGPT; Grok keeps the
  isolated-profile route. Without the option, behavior is unchanged.
- Each job creates a fresh tab, pins every browser command to it, and closes it on cleanup after
  verifying ownership. Relay mode never deletes a profile directory. Follow-ups open a new owned
  tab on the existing conversation URL; a missing or mismatched target fails closed.
- Preflight checks transport reachability, not login. Finish login or human verification in
  Chrome; `oracle_auth` refuses cookie import in relay mode.

## Cookie sources

### Linux

`/oracle-auth` delegates the default cookie read to `@steipete/sweet-cookie`'s Linux
Chrome/Chromium backend. The packaged default auto-detects existing Google Chrome, Chromium,
Chromium Browser, or Brave profile roots under `${XDG_CONFIG_HOME:-~/.config}` and passes
non-Google roots as absolute profile paths so the correct cookie DB is read. Set
`auth.chromeProfile` to another profile name, a profile directory, or a `Cookies` DB path when
needed, and leave `auth.chromiumKeychain` unset on Linux.

Sweet Cookie's Linux encrypted-cookie handling is controlled outside `omp-oracle`:

- `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic` selects GNOME/libsecret, KDE KWallet, or no
  keyring probing.
- GNOME probing shells out to `secret-tool`; KDE probing shells out to `kwallet-query` and
  `dbus-send`.
- `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` and `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD`
  bypass keyring probing when you already know the browser safe-storage password.

Do not put safe-storage passwords in project config or persistent shell startup files. Prefer
keyring helpers; if you use an environment override for one `/oracle-auth` run, it is scrubbed
from the environment before browser/helper subprocesses launch after cookie import.

### Custom Chromium cookie sources (macOS)

Most Chrome/Chromium-compatible browsers work through Sweet Cookie's default Chrome backend when
`auth.chromeProfile` points at the right profile or cookie DB. Sweet Cookie's Edge and Firefox
backends are not selected. The `auth.chromiumKeychain` alternate path is macOS-only and is for a
Chromium-family browser that is not one of Sweet Cookie's built-in Chrome/Brave/Arc/Chromium
targets or otherwise cannot import cookies without dependency patching.

Before running `/oracle-auth` with this path:

1. Log into ChatGPT or Grok in the target browser profile, depending on `defaults.provider`.
2. Fully quit the browser so its `Cookies` database is stable.
3. Find the profile `Cookies` SQLite DB path.
4. Find the browser's macOS Keychain safe-storage item account and service name.
5. Configure all of `browser.executablePath`, `auth.chromeCookiePath`, and
   `auth.chromiumKeychain` in the agent-level config.

Example macOS Helium config:

```json
{
  "browser": {
    "executablePath": "/Applications/Helium.app/Contents/MacOS/Helium"
  },
  "auth": {
    "chromeProfile": "Default",
    "chromeCookiePath": "/Users/you/Library/Application Support/net.imput.helium/Default/Cookies",
    "chromiumKeychain": {
      "account": "Helium",
      "services": ["Helium Storage Key"],
      "label": "Helium Storage Key"
    }
  }
}
```

`auth.chromeCookiePath` remains the cookie database path for backward compatibility. On macOS,
`auth.chromiumKeychain` must be paired with `auth.chromeCookiePath`; partial config is rejected so
oracle does not silently fall back to a different browser source. When both are present on
macOS, `/oracle-auth` uses the repo-owned generic Chromium cookie reader instead of patching
`@steipete/sweet-cookie` internals. On Linux, `auth.chromiumKeychain` is rejected; use Sweet
Cookie's Linux keyring/password environment options instead.

If macOS prompts for Keychain access during `/oracle-auth`, allow access for the configured
browser safe-storage item.

## Job outputs and retention

- Jobs persist `job.json`, `prompt.md`, the archive, `response.md`, `artifacts.json`,
  `artifacts/`, and `logs/worker.log` under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with
  private permissions (`0700` directories, `0600` files). The archive is deleted from the job
  directory once the upload succeeds. Full layout:
  [Architecture → Job layout](ARCHITECTURE.md#job-layout-under-the-configured-jobs-dir).
- Jobs queue automatically when runtime capacity is full.
- Completion delivery into the host session is one best-effort wake-up. A missed wake-up loses
  nothing: `/oracle-read [job-id]` and `oracle_read({ jobId })` read the saved output later.
- `/oracle-clean <job-id|all>` removes terminal job temp files. It briefly refuses cleanup right
  after a wake-up was sent so the follow-up turn can still read the saved paths, and returns the
  next eligible cleanup time.
- Terminal job directories are pruned by age: `cleanup.completeJobRetentionMs` (default 14
  days; `complete` and `cancelled` jobs) and `cleanup.failedJobRetentionMs` (default 30 days).

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_ORACLE_JOBS_DIR` | Job directory root (default `/tmp`) |
| `PI_ORACLE_STATE_DIR` | Lock and lease state root (default `/tmp/pi-oracle-state`) |
| `PI_ORACLE_CP_PATH` | `cp` executable for macOS APFS clone mode when the PATH lookup is wrong |
| `AGENT_BROWSER_PATH` | `agent-browser` executable when it is not on PATH, in `/opt/homebrew/bin`, or in `/usr/local/bin` |
| `SWEET_COOKIE_LINUX_KEYRING`, `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` | Linux encrypted-cookie handling (above) |

The names keep upstream's `PI_ORACLE_` prefix so existing configurations keep working after the
package rename.

## Troubleshooting

### `/oracle-auth` fails or says login is required

- Make sure the selected provider works in the same local browser profile you configured.
- For custom Chromium cookie sources, confirm `auth.chromeCookiePath` points at that profile's
  `Cookies` DB. On macOS, also confirm `auth.chromiumKeychain.services` names the browser's
  safe-storage Keychain service. On Linux, leave `auth.chromiumKeychain` unset and use Sweet
  Cookie's `SWEET_COOKIE_LINUX_KEYRING`, `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, or
  `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` options for encrypted Chrome/Chromium/Brave cookies.
- Re-run `/oracle-auth`.
- Agent callers can use `oracle_auth({})` once before retrying a stale-auth oracle submission.
- If the provider is half-logged-in or challenge flow state looks wrong, finish the
  login/challenge in the headed auth browser and retry.

### Custom Chromium auth says cookies synced but the session is rejected

This usually means the cookie import worked but the source cookies are not the active provider
session you expected.

1. Open the configured browser profile.
2. Confirm the selected provider works there without logging in again.
3. Quit the browser fully so its `Cookies` DB is stable.
4. Confirm `auth.chromeCookiePath` points at that exact profile's `Cookies` DB.
5. On macOS, confirm `auth.chromiumKeychain.services` names the browser's safe-storage Keychain
   service for that DB. On Linux, confirm the relevant Sweet Cookie keyring helper or
   Chrome/Brave safe-storage password override is available.
6. Re-run `/oracle-auth`.

### You hit a challenge or verification page

- Solve it in the auth/bootstrap browser if prompted (or in Chrome, in relay mode).
- Re-run `/oracle-auth` before submitting jobs again.

### You see "Oracle requires a persisted pi session"

- Do not run oracle with `--no-session` (`omp --no-session` or `pi --no-session`).
- Start a normal persisted session, then use `/oracle` again.

### A job finished but no wake-up arrived

- Use `/oracle-read [job-id]` to inspect the saved response preview.
- Use `/oracle-status` if you need help finding a recent job id.
- Agent callers can use `oracle_read({ jobId })`.
- Results are still saved on disk even if the reminder turn does not land.

### `/oracle-clean` refuses a terminal job right after completion

- This can happen during the short post-send retention grace window after a wake-up was sent.
- The command returns a `Retry after ...` timestamp when that guard is active.
- Wait until that time, then rerun `/oracle-clean <job-id|all>`.

### A local dependency like `agent-browser`, `tar`, or `zstd` is missing

Install the missing local dependency and rerun the command. `zstd` is only needed for ChatGPT
`.tar.zst` archive submissions; Grok submissions use `.tar.gz`. On macOS APFS clone mode, `cp`
must also be available on PATH or configured with `PI_ORACLE_CP_PATH`; Linux and Windows profile
copies use Node's recursive copy.

### Auto-detection picked the wrong browser profile

- Set `auth.chromeProfile` in the agent-level config.
- For custom Chromium cookie sources, set `auth.chromeCookiePath` to the exact profile `Cookies`
  DB. Pair it with `auth.chromiumKeychain` only on macOS; on Linux, rely on Sweet Cookie's
  keyring/password environment options.
- Re-run `/oracle-auth`.

### A Deep Research job ended with `deep_research_report_unreadable`

The research started in your ChatGPT account and `error`/`chatUrl` in `job.json` (and
`oracle_read`) carry the conversation URL, but the worker could not read the report out of the
research widget. Causes, in order of likelihood:

- the job ran on the isolated-profile transport — Deep Research needs `browser.chatGptRelayEndpoint`
  (the widget frame is only reachable through the relay's CDP session);
- the widget frame never attached within 60 s of sending (relay or Chrome hiccup) — rerun;
- the research exceeded `worker.completionTimeoutMs` (90 minutes by default).

Open the conversation URL for the report in any of these cases.

- `deep_research_clarification_requested` — the model replied (usually a question) instead of
  starting research; the reply is quoted in `error`. Restate the request with explicit assumptions
  and "do not ask clarifying questions".
- `deep_research_toggle_not_found` — the composer tools menu offered no Deep research entry, or
  the pill did not appear after selecting it. Check the account has Deep Research and that the
  ChatGPT page is a normal chat, then retry.

### A completed job reads `collection-status: partial`

Generation finished but the worker holds less than the whole turn. `oracle_read` and
`/oracle-read` list the gaps: required gaps (`bound_response_capture`,
`rich_response_fidelity`, …) mean the saved answer is degraded; optional gaps
(`native_markdown_export`, `artifact:<candidate>`) mean a secondary file is missing while
`response.md` is intact. `response.capture.json` carries the exact turn binding, fidelity, and
source URLs.

Do not resubmit. Run `oracle_read({ jobId, action: "recollect" })`: the worker opens a fresh
disposable session, reacquires the exact bound turn, and repeats collection only; it never
configures, uploads, or sends. Jobs completed before turn binding existed need the observed
`responseIndex` and `messageId` together (`data-message-id` of the assistant turn). A failed
recollection records `recollectionError` and keeps the earlier usable output.

For Deep Research, recollection re-activates Export → Export to Markdown; the browser saves its
own copy in Chrome's configured download directory each time (the worker never changes that
destination), and the validated bytes land under `artifacts/<sha256>-deep-research-report.md`.

### The prompt arrived with unrelated text in front of it (relay mode)

ChatGPT restores a saved draft into the composer of your signed-in Chrome, and filling the
composer used to append to it. The worker now clears the composer before filling; if you still
see a prefix, clear the draft in Chrome and rerun.

### You want more details about a failed run

Inspect the job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/`. The worker log
and captured diagnostics are stored there. For auth runs, use the `/tmp/pi-oracle-auth-*/`
directory printed by `/oracle-auth`.
