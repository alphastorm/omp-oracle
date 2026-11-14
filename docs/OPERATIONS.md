# OMP Oracle operations

This manual is for operators who have installed OMP Oracle (`omp-oracle`) in Oh My Pi (OMP) or `pi`, the coding agents (hosts) that load the extension. Use it to configure settings, set up a sign-in transport, inspect and recover jobs, drive Oracle from a program, and look up every command, tool, key, error code, and environment variable.

Companion guides: [Get started](../README.md#get-started) · [Documentation index](README.md) · [Compatibility](COMPATIBILITY.md) · [Security model](SECURITY.md) · [Architecture](ARCHITECTURE.md).

## Before you start

Before running `/oracle-auth` or `/oracle`, confirm that your machine and host session (one running agent session) meet these runtime prerequisites:

- `agent-browser` `0.41.2` or newer is required on every transport.
- `tar` on `PATH` is required to build the context archive (the compressed copy of selected project files that a job uploads).
- `zstd` on `PATH` is required when the provider (ChatGPT or Grok) is ChatGPT, which uploads `.tar.zst` archives (`250 MiB` upload ceiling); Grok uploads `.tar.gz` archives (`200 MiB` upload ceiling) and needs no `zstd`.
- `cp` on `PATH` (or `PI_ORACLE_CP_PATH`) is required on macOS when isolated-seed jobs clone profiles with `apfs-clone`.
- Chrome or a Chromium-family binary (`browser.executablePath`) is required for the isolated seed profile and the managed browser.
- A persisted host session is required (do not pass `--no-session`; pass `--session-dir` in print mode).

Check your `agent-browser` version, and upgrade if preflight reports an older release:

```bash
agent-browser --version
npm install -g agent-browser@latest
brew upgrade agent-browser
```

If you have not installed `omp-oracle`, start with [Get started](../README.md#get-started). For supported platforms, hosts, and why the driver floor exists, see [Platforms and runtime](COMPATIBILITY.md#platforms-and-runtime).

## Config files

Most installations need no configuration file; create an `oracle.json` file only to override defaults, cookie sources, browser paths, or sign-in transports.

| Scope | Oh My Pi | `pi` | Allowed top-level keys |
| --- | --- | --- | --- |
| Agent-level config | `~/.omp/agent/extensions/oracle.json` | `~/.pi/agent/extensions/oracle.json` | Every key, including `browser` and `auth` |
| Project config | `.omp/extensions/oracle.json` | `.pi/extensions/oracle.json` | `defaults`, `worker`, `poller`, `artifacts`, `cleanup` |

Each path joins the host's agent directory or project config directory with `extensions/oracle.json`. Only the agent-level config may set `browser` and `auth`, because those keys control local browser binaries, profile paths, cookie sources, Keychain items, and Chrome DevTools endpoints. A trusted project config that sets `browser`, `auth`, or any other disallowed top-level key fails config loading with `Invalid oracle project config: <key> cannot be overridden at the project level`.

Inside a running session, the extension asks the host whether the project is trusted; a host without a project-trust check counts the project as trusted. When the host marks the project untrusted—such as a session started with `--no-approve` (`-na`) or a saved untrusted decision on `pi` (`--approve` or `-a` trusts the project)—Oracle skips the project `oracle.json` file whole and uses only the agent-level file.

Code that loads config outside a host session honors `--approve` (`-a`) and `--no-approve` (`-na`) first, then `pi`'s saved trust decision. With no flag and no trust store, it loads no project file.

To see which config files an isolated-seed `/oracle-auth` run used, read `oracle-auth.log` in the diagnostics directory the command prints. The log records `Effective oracle auth config: ...` and whether a project config was also loaded; a failed run prints the same lines.

On any transport, the session footer shows readiness, and `oracle_preflight` (or `/oracle-run preflight`) reports the session, config, and transport checks. For every key, default, bound, and a complete JSON example, see the [Configuration reference](#configuration-reference).

<a id="choose-an-auth-transport"></a>
## Choose a sign-in transport

A sign-in transport is how a job reaches a signed-in provider session; pick the one that matches your provider and browser setup.

| Transport | Providers | Choose it when | Setup |
| --- | --- | --- | --- |
| Isolated seed profile (default) | ChatGPT, Grok | You use Grok or standard ChatGPT presets (not `deep_research`), leaving your browser untouched | [Isolated seed profile](#isolated-seed-profile-default) |
| Existing-Chrome relay | ChatGPT only | You run a signed-in Chrome with a loopback CDP relay, or need `deep_research` there | [Existing-Chrome relay](#existing-chrome-relay-chatgpt-only) |
| Managed browser | ChatGPT only | You want a dedicated ChatGPT Chrome profile (including `deep_research`) opened and quit automatically | [Managed ChatGPT browser](#managed-chatgpt-browser-dedicated-account) |

What each transport touches on your machine:

- **Isolated seed profile:** Reads local browser cookies in read-only mode into the auth seed profile (`<agent dir>/extensions/oracle-auth-seed-profile`, or `<authSeedProfileDir>-grok` for Grok), then clones and deletes a disposable runtime profile per job.
- **Existing-Chrome relay:** Attaches to a loopback Chrome DevTools Protocol (CDP) endpoint (`browser.chatGptRelayEndpoint`), drives one job-owned pinned tab (a single tab the job creates, pins every command to, and closes), and copies no cookies.
- **Managed browser:** Opens or reuses a dedicated Chrome user-data directory (`browser.chatGptManagedProfileDir`) on an ephemeral loopback port, drives one job-owned pinned tab, and quits an Oracle-started Chrome when idle.
- **Dedicated account in persistent Chrome:** If you prefer to keep a dedicated Chrome process running yourself on a fixed loopback port instead of letting Oracle launch and quit it, use the [Dedicated account in persistent Chrome](#dedicated-account-in-persistent-chrome) setup recipe for `browser.chatGptRelayEndpoint`.

Together, the existing-Chrome relay and the managed browser are the shared Chrome transports.

<a id="auth-transports"></a>
## Set up a transport

Configure one ChatGPT transport at a time; Grok always uses its isolated seed profile.

### Isolated seed profile (default)

The isolated seed profile imports provider cookies once into an Oracle-owned profile and clones a separate runtime profile for each job.

Before starting, sign in to ChatGPT or Grok in your local Chrome, Chromium, or Chromium-family browser profile (`auth.chromeProfile`, auto-detected by default).

1. Edit `~/.omp/agent/extensions/oracle.json` or `~/.pi/agent/extensions/oracle.json` only if you want to override `defaults.provider` (`"chatgpt"` or `"grok"`) or `auth.chromeProfile`; default setups need no config file.
2. Run `/oracle-auth` for ChatGPT or `/oracle-auth grok` for Grok (and rerun it whenever a job reports that login is required):
   ```text
   /oracle-auth
   /oracle-auth grok
   ```
   On success the command prints `Oracle auth synced.`, the cookie source, the auth seed profile path, and the path of its `pi-oracle-auth-*` diagnostics directory under the system temporary directory.
3. Check the session footer (or ask the agent to call `oracle_preflight`); you see `oracle: ready` (or `Oracle preflight ready for ChatGPT.` / `Grok.`).

#### How the isolated seed profile behaves

- `/oracle-auth` imports cookies read-only into `browser.authSeedProfileDir` (default `<agent dir>/extensions/oracle-auth-seed-profile`, or `<authSeedProfileDir>-grok` for Grok) and writes a `.oracle-seed-generation` marker; agent callers can call `oracle_auth({})` once before retrying a stale-auth submission.
- Each `/oracle-auth` run writes diagnostics to a `0700` `pi-oracle-auth-*` directory under the system temporary directory (use the path `/oracle-auth` prints): `oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, `oracle-auth.body.txt`, and `oracle-auth.png` when a screenshot was taken.
- Each job clones the auth seed profile into `browser.runtimeProfilesDir` (default sibling `oracle-runtime-profiles`), runs headless by default (`browser.runMode`), and deletes its runtime profile on exit; up to `browser.maxConcurrentJobs` (default `2`) run concurrently.
- Missing, unreadable, non-directory, or unverified seed profiles fail preflight with `auth_seed_profile_missing`, `auth_seed_profile_unreadable`, `auth_seed_profile_invalid_type`, or `auth_seed_profile_unauthenticated`.
- Deep Research (`deep_research`, a ChatGPT preset that turns on a composer tool rather than selecting a model tier) is unsupported on the isolated seed profile because its cross-origin report widget frame requires shared Chrome; runs on the isolated seed fail with `deep_research_report_unreadable`.

### Existing-Chrome relay (ChatGPT only)

The existing-Chrome relay drives one job-owned pinned tab in a signed-in Chrome you already run behind a loopback CDP endpoint, without copying cookies.

You need a signed-in Chrome session, `agent-browser` `0.41.2` or newer with pinned-tab support, and a loopback CDP relay—such as Oh My Pi's browser relay on `http://127.0.0.1:9224` or a Chrome started with `--remote-debugging-port` ([Dedicated account in persistent Chrome](#dedicated-account-in-persistent-chrome))—that exposes target discovery (`Target.getTargets`), creation, attachment, and closure. Older OMP relay builds without `Target.getTargets` cannot serve `agent-browser`.

Do not run `/oracle-auth` or `oracle_auth` in relay mode; both refuse cookie import when `browser.chatGptRelayEndpoint` is set.

1. Set `browser.chatGptRelayEndpoint` in your agent-level `oracle.json`:
   ```json
   { "browser": { "chatGptRelayEndpoint": "http://127.0.0.1:9224" } }
   ```
   Save the file.
2. Complete ChatGPT login or any human verification directly in that Chrome window so ChatGPT opens ready to chat.
3. Check the session footer (or ask the agent to call `oracle_preflight`); you see `oracle: ready` or `Relay transport reachable at http://127.0.0.1:9224.`

#### How the relay behaves

- Each job creates a fresh tab, pins every browser command to it, and closes only that tab on cleanup after verifying ownership (or releases the window's last tab to `about:blank`).
- Same-thread follow-ups open a new owned tab on the saved conversation URL; a missing or mismatched target fails closed, and relay mode never deletes a profile directory.
- `browser.chatGptRelayEndpoint` is agent-level only, mutually exclusive with `browser.chatGptManagedProfileDir`, and applies to ChatGPT only (Grok uses the isolated seed profile).
- Preflight checks endpoint reachability (`relay_unavailable` and `oracle: browser unavailable` when unreachable), not ChatGPT login; the worker checks login before uploading, and Oracle does not verify an expected account email.

### Managed ChatGPT browser (dedicated account)

The managed ChatGPT browser runs a dedicated Chrome user-data directory on a loopback ephemeral port, starting Chrome on demand and quitting an Oracle-started Chrome when idle.

For work/personal account isolation, use a dedicated Chrome user-data directory rather than ChatGPT's account picker inside a shared profile, because tabs and windows in one profile share auth state. The directory must be separate from your personal browser profile roots, both providers' auth seed profiles, and `browser.runtimeProfilesDir`, cannot be combined with `browser.chatGptRelayEndpoint`, and requires `browser.executablePath` when Chrome is not auto-detected (such as on Windows).

1. Set `browser.chatGptManagedProfileDir` in your agent-level `oracle.json` (macOS path shown; pick a private directory on Linux or Windows):
   ```json
   { "browser": { "chatGptManagedProfileDir": "~/Library/Application Support/omp-oracle/work-chrome" } }
   ```
   Until that directory exists, the session footer shows `oracle: auth needed` (`managed_browser_profile_missing`).
2. Run `/oracle-auth` (or ask the agent to call `oracle_auth({})`) so Chrome creates the profile directory and opens ChatGPT sign-in:
   ```text
   /oracle-auth
   ```
   A headed Chrome window opens on the sign-in tab and stays open while that tab remains open. From this point the footer shows `oracle: ready`: readiness checks the profile directory and the browser, not the login.
3. Sign in to the intended ChatGPT account on that tab, then run `/oracle-auth` again to confirm. It opens a second tab to check the login, closes that tab, and prints `ChatGPT is already signed in in the managed browser (<profileDir>); nothing to do.`
4. Close the tab you signed in on. A Chrome that Oracle started stays open while any page is open.

#### How the managed browser behaves

- A ChatGPT job reuses a running Chrome serving that profile or launches one via `browser.executablePath` (headed, loopback DevTools with `--remote-debugging-address=127.0.0.1` and `--remote-debugging-port=0`, and the three `--disable-*` anti-backgrounding flags), driving one job-owned pinned tab and closing it on cleanup.
- A keeper process owns each Chrome that Oracle starts and quits it `120000` ms (`2` minutes, overridable via `PI_ORACLE_MANAGED_BROWSER_IDLE_MS`) after the last job finishes with no non-blank page open; a Chrome you opened yourself is reused and never quit by Oracle.
- Oracle reuses an already-open Chrome only when the profile's `DevToolsActivePort` record (written by `--remote-debugging-port=0`) matches the live browser identity; a Chrome holding the profile without that record blocks jobs with `oracle: browser unavailable` (`managed_browser_in_use`) until you quit it, and Oracle never launches a second instance into an active profile.
- Before each browser command, the worker compares the live `/json/version` `webSocketDebuggerUrl` with the saved `browserUrl` (`managedBrowser` in `job.json`); if Chrome exited mid-job and another browser took its port, the worker stops with `managed_browser_changed` before sending anything there (resubmit to reopen on a fresh port).
- Launching a closed Chrome adds startup time and focuses the window when the first job tab opens; keep the window un-minimized while jobs run.
- Readiness checks profile and browser availability rather than ChatGPT login; if the profile is signed out, the worker stops before upload with `ChatGPT login is required. Run /oracle-auth.` Oracle checks no expected account email, Grok keeps the isolated seed profile, and completed `deep_research` runs with native Markdown export on the managed browser are recorded in the [release ledger](RELEASE.md#evidence-ledger).

### Dedicated account in persistent Chrome

This setup recipe runs a dedicated Chrome process yourself on a fixed loopback CDP port and attaches Oracle to it through `browser.chatGptRelayEndpoint`, without a relay extension or cookie import.

Choose a dedicated `--user-data-dir` outside your personal Chrome profile root, and never connect that profile to a personal relay extension.

1. Launch a separate Chrome process with persistent storage, a fixed loopback port (`127.0.0.1:9333`), and the three anti-backgrounding flags (macOS example):
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --user-data-dir="$HOME/Library/Application Support/omp-oracle/work-chrome" \
     --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 \
     --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
     --no-first-run --no-default-browser-check --new-window https://chatgpt.com/
   ```
   A dedicated Chrome window opens at `https://chatgpt.com/`.
2. Sign in to ChatGPT only as the intended account in that window (Chrome sync is unnecessary).
3. Point `browser.chatGptRelayEndpoint` at that loopback port in your agent-level `oracle.json`:
   ```json
   { "browser": { "chatGptRelayEndpoint": "http://127.0.0.1:9333" } }
   ```
   Save the file.
4. Check the session footer (or ask the agent to call `oracle_preflight`); you see `oracle: ready` when the browser answers, or `oracle: browser unavailable` (`relay_unavailable`, naming the endpoint and cause) while it is closed.

#### How persistent Chrome behaves

- Keep this Chrome running while jobs execute, and relaunch it with the same command after quitting or rebooting; Oracle never starts or quits it, never falls back to personal Chrome when `http://127.0.0.1:9333` is down, and restores `oracle: ready` automatically once the endpoint answers again.
- `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, and `--disable-background-timer-throttling` keep the job tab rendering while the window sits behind other windows (without them, Chrome stops painting occluded tabs and freezes ChatGPT's streamed turn); leave the window un-minimized and let jobs own its tabs, while the worker reloads the conversation after generation to catch any tokens a background tab did not paint.
- Keep the CDP port on `127.0.0.1` and only the intended account signed in; Oracle verifies login readiness rather than account email, and existing conversation URLs stay tied to the account that created them.
- Native CDP has been exercised with Instant upload, response collection, cleanup, and cross-origin frame capture. Completed `deep_research` runs with native Markdown export on the managed browser are recorded in the [release ledger](RELEASE.md#evidence-ledger); this manual persistent-Chrome setup has no recorded Deep Research run.

## Cookie sources

When using the isolated seed profile, `/oracle-auth` reads cookies from your configured local Chromium-family profile without modifying that source profile.

### Linux

On Linux, `/oracle-auth` delegates default cookie reads to `@steipete/sweet-cookie`'s Chrome/Chromium backend, auto-detecting Google Chrome, Chromium, Chromium Browser, and Brave profile roots under `${XDG_CONFIG_HOME:-~/.config}` and passing non-Google roots as absolute profile paths so the intended `Cookies` database is read.

Set `auth.chromeProfile` in agent-level `oracle.json` to another profile name, profile directory, or `Cookies` database path when needed, configure `SWEET_COOKIE_LINUX_KEYRING=gnome|kwallet|basic` or a one-run password override below for encrypted cookies, and leave `auth.chromiumKeychain` unset on Linux (setting it on Linux fails config validation).

| Variable | Allowed values | Effect |
| --- | --- | --- |
| `SWEET_COOKIE_LINUX_KEYRING` | `gnome` \| `kwallet` \| `basic` | Selects GNOME (`secret-tool`), KDE (`kwallet-query`, `dbus-send`), or no keyring probing |
| `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` | Password string | One-run password override for Google Chrome and other non-Chromium/non-Brave paths |
| `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD` | Password string | One-run password override for `~/.config/chromium` and Snap or Flatpak Chromium roots |
| `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD` | Password string | One-run password override for Brave profiles |

Do not put safe-storage passwords in project config or shell startup files. Prefer keyring helpers (`secret-tool` or `kwallet-query`); when you pass a `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` override in the environment for one `/oracle-auth` run, Oracle scrubs every matching variable from the environment before launching browser, helper, or archive subprocesses.

### Custom Chromium cookie sources (macOS)

Most Chrome/Chromium-compatible browsers work through Sweet Cookie's default Chrome backend when `auth.chromeProfile` points at the right profile or cookie database. Sweet Cookie's Edge and Firefox backends are not selected. On macOS, `auth.chromiumKeychain` supports Chromium-family browsers outside Sweet Cookie's built-in Chrome, Brave, Arc, and Chromium targets.

`auth.chromiumKeychain` is macOS-only and requires `auth.chromeCookiePath` in agent-level `oracle.json`; partial config is rejected so `/oracle-auth` never falls back silently to another browser source.

1. Sign in to ChatGPT or Grok in the target browser profile, matching `defaults.provider`.
2. Quit that browser completely so its `Cookies` SQLite database and `Cookies-wal` / `Cookies-shm` sidecars are stable on disk.
3. Locate the profile's `Cookies` SQLite database path.
4. Open Keychain Access and inspect the browser's Safe Storage item to find its `Account` (`account`) and `Where` (`services`) values (`label` is an optional human-readable name for error messages).
5. Set `browser.executablePath`, `auth.chromeCookiePath`, and `auth.chromiumKeychain` together in your agent-level `oracle.json`:
   ```json
   {
     "browser": { "executablePath": "/Applications/Helium.app/Contents/MacOS/Helium" },
     "auth": {
       "chromeProfile": "Default",
       "chromeCookiePath": "/Users/you/Library/Application Support/net.imput.helium/Default/Cookies",
       "chromiumKeychain": { "account": "Helium", "services": ["Helium Storage Key"], "label": "Helium Storage Key" }
     }
   }
   ```
   Save the file.
6. Run `/oracle-auth` (or `/oracle-auth grok` for Grok) and approve the macOS Keychain prompt if requested:
   ```text
   /oracle-auth
   ```
   Oracle snapshots the `Cookies` database, decrypts the provider cookies, and prints `Oracle auth synced.`
7. Check the session footer (or ask the agent to call `oracle_preflight`); you see `oracle: ready`.

<a id="job-outputs-and-retention"></a>
## Work with jobs

Every submitted request is a job: one prompt and one archive tracked in a private job directory on disk until retention or `/oracle-clean` removes it.

### Where a job's files live

Each job writes its state, prompt, answer, artifacts, and logs under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with `0700` directory permissions and `0600` file permissions.

| File or path | When written | Contents |
| --- | --- | --- |
| `job.json` | Job creation and updates | Status, phase, `promptSendState`, `observedSelection`, `errorCode`, and file paths |
| `prompt.md` | Job creation | Exact prompt text sent with the job |
| `context-<job-id>.tar.zst` or `context-<job-id>.tar.gz` | Before upload | Compressed project archive; deleted once upload is confirmed |
| `response.md` | Bound turn capture | Saved assistant reply or Deep Research report in Markdown |
| `response.capture.json` | Collection | Turn binding, capture method, fidelity, code blocks, sources, and collection gaps |
| `response.raw.txt`, `response.raw.html`, `response.block-<n>.txt` | Bound DOM capture | Redacted innerText, sanitized DOM HTML, and exact text per code block |
| `artifacts.json`, `artifacts/<sha256>-<file name>` | Artifact collection | Redacted download manifest and validated files (`25 MiB` cap per download) |
| `logs/worker.log` | Worker execution | Timestamped worker progress, warnings, and teardown log |
| `logs/<reason>.url.txt`, `.snapshot.txt`, `.body.txt`, `.signals.txt`, `.png` | Worker failure | Page URL, interactive snapshot, body text, page signals, and screenshot |

Worker failure captures write `logs/<reason>.url.txt`, `logs/<reason>.snapshot.txt`, `logs/<reason>.body.txt`, `logs/<reason>.signals.txt`, and `logs/<reason>.png` for `<reason>` values `preflight-auth-transition`, `preflight-challenge`, `preflight`, `preflight-timeout`, `send-not-accepted`, and `failure`.

When recollection overwrites `response.md`, `response.capture.json`, `response.raw.txt`, `response.raw.html`, `response.block-<n>.txt`, or an artifact with different bytes, Oracle preserves the prior bytes at `<capture-file>.<sha256>.previous`.

Results outlive the agent turn, subject to age-based retention, `/oracle-clean`, and the lifetime of `${PI_ORACLE_JOBS_DIR:-/tmp}` (default `/tmp`); see [Job layout under the configured jobs dir](ARCHITECTURE.md#job-layout-under-the-configured-jobs-dir) for every `job.json` field.

### Check status and read the answer

When a job finishes, the session poller delivers one best-effort wake-up message to the asking host session once that session is idle with no pending messages. Jobs that finish together arrive as one batched message. If the asking session is gone, another saved session in the same project delivers the wake-up.

If the asking session reads a finished job with `oracle_read` before the first attempt, the wake-up is settled and none is sent. `/oracle-status` and `/oracle-read` settle it only after a first attempt, which stops the retries; before that they only record that the job was seen.

Agents must not poll in a loop; when a user asks for status before the wake-up arrives, call `oracle_read({ jobId })` once with the submitted job's id. From the interactive prompt, inspect jobs directly from the durable job directory:

```text
/oracle-status
/oracle-status <job-id>
/oracle-read <job-id>
```

`/oracle-status` with no `<job-id>` shows the latest job in the current project and lists up to five recent job ids; `/oracle-read` appends up to `4000` characters of `response.md` (labeled with the full character count when truncated, while `response.md` holds the complete text).

### Read a job from another project

All projects share `${PI_ORACLE_JOBS_DIR:-/tmp}`, so a job submitted from another working directory can be read by id once you acknowledge its owning project root.

1. Run `/oracle-status <job-id>` or `oracle_read({ jobId })` first; when the job belongs to another project, Oracle refuses with `job_wrong_project` and prints the exact owning `projectId` (`Oracle job <job-id> belongs to project "<project-root>".`).
2. Repeat the read or status command with that exact root:
   ```text
   /oracle-status <job-id> --projectId "/abs/project"
   /oracle-read <job-id> --projectId "/abs/project"
   ```
   Agent callers pass `oracle_read({ jobId: "<job-id>", projectId: "/abs/project" })`; you see the job summary (and response preview on read). Omitting `<job-id>` (`/oracle-status --projectId "/abs/project"`) shows that project's latest job and up to five recent job ids.

Constraints on `--projectId`:

- `--projectId` parses a leading `"` with `JSON.parse`, so wrap any `<project-root>` containing spaces in double quotes (`"/abs/project"`); single quotes or shell-escaped spaces fail.
- Lookup checks only the active `${PI_ORACLE_JOBS_DIR:-/tmp}` root, so use the same jobs root as the submitting helper.
- Cross-project acknowledgment applies only to status and read; `/oracle-cancel`, `/oracle-clean`, follow-ups, and wake-up ownership remain scoped to the submitting project.

### See which model a job used

To check which UI controls the worker observed in the browser—separate from the requested preset—read the observed selection lines in `/oracle-status`, `/oracle-read`, or `oracle_read`, or inspect `observedSelection` in `job.json`.

| Read or status field | `job.json` source | Meaning |
| --- | --- | --- |
| `observed-product` | `observedSelection.product` | Observed product surface when recorded |
| `observed-model` | `modelLabel`, `effortLabel`, `at` | Picker label, thinking-effort slider stop, and observation timestamp |
| `deep-research-verified` | `deepResearchVerified` | `true` when the Deep Research composer pill was verified before send |
| `deep-research-iframe-title` | `deepResearchIframeTitle` | Title read from the bound Deep Research report iframe |

`job.json` also records `observedSelection.effortControls` (`"absent"` or `"unavailable"` when no slider stop applies) and `observedTurn` (`turn-duration` in read/status output, with `durationLabel` and `durationSeconds`).

Deep Research turns on a composer tool rather than selecting an ordinary model tier, so it carries no ordinary `modelLabel`. Missing fields mean a control was not observed (or the job predates `observedSelection`), not a failed job, and these fields never contain answer text or credentials.

### Continue, cancel, and clean up

Use `/oracle-followup` to continue a completed job's conversation, `/oracle-cancel` to stop an open job, and `/oracle-clean` to remove terminal job files.

```text
/oracle-followup <job-id> <request>
/oracle-cancel <job-id>
/oracle-clean <job-id>
/oracle-clean all
```

- **Follow-ups and existing threads:** `/oracle-followup <job-id> <request>` (or `followUpJobId` on `oracle_submit`) continues a `complete` ChatGPT or Grok job (mode `heavy` on Grok) from the current project in the same provider thread. Naming an existing ChatGPT conversation id (`6a28ab5c-e4d4-83e8-b8be-dd39f38a26d6`) or `https://chatgpt.com/c/...` URL in `/oracle <request>` instructs the agent to pass `chatGptConversationId` to `oracle_submit`.
- **Cancellation:** `/oracle-cancel <job-id>` (or `oracle_cancel({ jobId })`) stops a `queued`, `preparing`, `submitted`, or `waiting` job in the current project and promotes queued jobs once cleanup completes.
- **Manual cleanup and grace window:** `/oracle-clean <job-id|all>` runs runtime teardown and deletes `complete`, `failed`, and `cancelled` job directories in the current project. It refuses non-terminal jobs, jobs with a live worker PID, jobs with an active 60-second notification claim, and jobs within the `2`-minute (`120000` ms) post-send retention grace window after a wake-up attempt (printing `Retry after <timestamp>`).
- **Cleanup retries:** While a host session is open (or when a command or submission runs), background cleanup makes at most five teardown attempts in total—the initial teardown plus four retries spaced `15 s`, `1 min`, `5 min`, and `15 min` apart, recording up to `8` warnings of `500` characters in `cleanupWarnings` in `job.json`—after which `/oracle-clean` retries on request.
- **Age retention:** Terminal job directories are pruned automatically by age after `cleanup.completeJobRetentionMs` (`1209600000` ms, `14 days`, for `complete` and `cancelled` jobs) and `cleanup.failedJobRetentionMs` (`2592000000` ms, `30 days`, for `failed` jobs).

### Recollect a finished answer

Provider writing the answer is generation, saving that answer and its files to disk is collection, and repeating collection on a finished turn without sending a prompt is recollection.

- `generationStatus` in `job.json` (`generation-status` in read/status output) is `"completed"` once provider generation finishes, and absent before then.
- `collectionStatus` (`collection-status`) is `complete`, `partial`, or `failed`, paired with `response.capture.json` (`conversationId`, `responseIndex`, `messageId`, content hash, fidelity, source URLs, code blocks, and artifact inspection).
- `collection-optional-missing` (`native_markdown_export`, `artifact:<id>`) means a secondary file failed while `response.md` is intact; `collection-required-missing` (`bound_response_capture`, `rich_response_fidelity` when rich formatting fell back to plain text, `unresolved_source_links`, `redacted_transport_links` when signed URLs were scrubbed) means the saved answer is degraded or missing; `recollection-needed` means the bound turn was not captured and no `response.md` was written.
- `promptSendState` in `job.json` (`prompt-send-state` in `oracle_read`) is `not_sent`, `attempted`, or `accepted`, showing whether resubmitting is safe.
- To retry collection without resending the prompt, ask the agent to call `oracle_read({ jobId: "<job-id>", action: "recollect" })` or invoke `/oracle-run read` while the job's sign-in transport is available. This works on a `complete` job, and on a ChatGPT job that failed with `Timed out waiting for ChatGPT response completion` after `prompt-send-state: accepted`. Timed-out Grok recollection is unsupported in this version: it is refused before any job or lease changes, and nothing is resent. A timed-out chat reply must pass the ordinary completion detector on its bound turn, then produce two identical non-empty reads after reloading. The second verified capture is the one saved; a failed or unstable reload never earns a receipt.
- The recollect read is synchronous. A timed-out chat reply can take the job's saved `worker.completionTimeoutMs` (90 minutes by default), plus up to five minutes of startup and ten minutes for reload, capture, downloads, and cleanup. The worker enforces those budgets; the read's backstop adds a further one-minute margin (106 minutes with the default chat wait). The final minute of collection is reserved for persistence/cleanup. If optional downloads exhaust the work budget, the verified reply is retained and the job completes with `complete_with_artifact_errors`; inspect the artifact gaps and retry collection later. While waiting, the job remains `failed` with its original timeout text and `completedAt`. If verification expires or is interrupted, `recollectionError` explains why, nothing was resent, and a later recollection remains possible after cleanup.
- Deep Research verifies completion through the bound widget's `Research completed in …` marker and a non-empty report body, not mere frame or text presence. Collection checks again and refuses a disappeared or changed report. Its recollection retains a shorter, existing 60-second report wait rather than the chat completion timeout: if research has not finished within that wait, the job keeps its original timeout failure without `recollectionCompletionVerifiedAt`.
- Successful timeout recovery sets `recollectionCompletionVerifiedAt` to an ISO-8601 UTC timestamp at the completion transition, exposed unchanged in the read result and as `recollection-completion-verified-at` in status text. Ordinary completion and recollection of an already complete job do not create it; artifact recollection preserves an existing value. A session already told that the job failed receives nothing when recollection succeeds: its one wake-up is not repeated. The caller learns the result from the read itself.
- Most jobs need no binding arguments. A legacy completed job recorded before automatic turn binding takes zero-based `responseIndex` and DOM `data-message-id` `messageId` together; a timed-out job recorded before its reply index was saved takes `responseIndex` alone.

### Capacity and queueing

Up to `browser.maxConcurrentJobs` (default `2`, range `1`–`32`) jobs run concurrently across all projects sharing `PI_ORACLE_STATE_DIR`, and new submissions queue only when every runtime slot is busy.

- **Queue caps:** The global queue holds at most `browser.maxConcurrentJobs` queued jobs (default `2`) and at most `browser.maxConcurrentJobs` × `250 MiB` (`500 MiB` by default) of archives across queued jobs and retained pre-submit archives; exceeding either cap rejects the submission. `oracle_preflight` reports global capacity (`Capacity: 1/2 active, 0/2 queued (global).`) before archive creation.
- **Same-thread contention:** When a runtime slot is free but another active job already holds the target ChatGPT conversation, `oracle_submit` refuses the submission instead of queueing it: `Oracle conversation <id> is already in use by job <id>. Concurrent jobs targeting the same ChatGPT thread are not allowed.` Wait for the active job on that conversation to finish before submitting the follow-up.

## Commands and tools

OMP Oracle registers eight slash commands, five agent tools, and a live status indicator in the host session footer.

### Commands

Type slash commands directly into `omp` or `pi` (or pass `/oracle-run` in print mode).

| Usage | What it does |
| --- | --- |
| `/oracle <request>` | Prompts the agent to preflight, gather project files, and submit a job |
| `/oracle-followup <job-id> <request>` | Continues completed job `<job-id>` in the same provider conversation |
| `/oracle-auth [chatgpt\|grok]` | Imports cookies into the auth seed profile or opens managed-browser sign-in |
| `/oracle-status [job-id] [--projectId <project-root>]` | Shows one job, or the latest job plus up to five recent job ids when no id is given |
| `/oracle-read [job-id] [--projectId <project-root>]` | Shows job status and the first `4000` characters of `response.md` |
| `/oracle-cancel <job-id>` | Cancels a queued or active job in the current project |
| `/oracle-clean <job-id\|all>` | Tears down runtime state and removes terminal job directories in this project |
| `/oracle-run <preflight\|submit\|read> <request.json> <result.json> [<marker.json>]` | Runs `oracle_preflight`, `oracle_submit`, or `oracle_read` from JSON with no model turn |

### Tools

Agents call five tools; provider parameters normalize `"chatgpt"`, `"chat-gpt"`, `"openai"` and `"grok"`, `"xai"`, `"x.ai"`, and preset parameters match any canonical id or label in `ORACLE_SUBMIT_PRESETS` ([Providers and presets](../README.md#providers-and-presets)). A failed call returns `details.error` with `code`, `message`, and `suggestedNextStep` (plus `rejectedValue` and `allowedValues` when applicable).

`oracle_preflight` checks persisted-session readiness, config, transport or seed prerequisites, and global capacity before archive work:

| Parameter | Required | Allowed values | What it does |
| --- | --- | --- | --- |
| `provider` | Optional | `"chatgpt"` \| `"grok"` | Provider to check; defaults to the follow-up thread's provider or `defaults.provider` |
| `followUpJobId` | Optional | Completed job id | Checks readiness for continuing an Oracle job's thread |
| `chatGptConversationId` | Optional | ChatGPT id or `https://chatgpt.com/c/...` URL | Checks readiness for continuing an existing ChatGPT thread |

`oracle_auth` refreshes the isolated auth seed profile or opens managed-browser sign-in (refused in relay mode):

| Parameter | Required | Allowed values | What it does |
| --- | --- | --- | --- |
| `provider` | Optional | `"chatgpt"` \| `"grok"` | Provider to authenticate; defaults to `defaults.provider` |

`oracle_submit` builds the project archive and dispatches or queues a background job:

| Parameter | Required | Allowed values | What it does |
| --- | --- | --- | --- |
| `prompt` | Required | String | Prompt text sent to ChatGPT or Grok |
| `files` | Required | Non-empty `string[]` | Exact project-relative paths, or `["."]` for a whole-repo archive |
| `provider` | Optional | `"chatgpt"` \| `"grok"` | Target provider; must match any follow-up thread |
| `preset` | Optional | Id or label in `ORACLE_SUBMIT_PRESETS` | ChatGPT model or `deep_research` tool; forbidden when `provider` is `"grok"` |
| `mode` | Optional | `"heavy"` | Grok execution mode; forbidden when `provider` is `"chatgpt"` |
| `followUpJobId` | Optional | Completed job id | Continues an earlier completed Oracle job in the current project |
| `chatGptConversationId` | Optional | ChatGPT id or `https://chatgpt.com/c/...` URL | Continues a ChatGPT thread; mutually exclusive with `followUpJobId` |

`oracle_read` reads saved job status and up to `4000` characters of `response.md`, or recollects a completed job or a timed-out ChatGPT reply:

| Parameter | Required | Allowed values | What it does |
| --- | --- | --- | --- |
| `jobId` | Required | Job id | Job to inspect or recollect |
| `projectId` | Optional | Non-empty path | Acknowledges the owning root when reading another project's job |
| `action` | Optional | `"read"` \| `"recollect"` | `"read"` (default) reads saved files; `"recollect"` re-captures the reply of a `complete` job, or of a ChatGPT job that timed out after its prompt was accepted; timed-out Grok recollection is unsupported |
| `responseIndex` | Optional | Integer `>= 0` | Zero-based assistant turn index when no binding was saved: with `messageId` for a legacy completed job, alone for a timed-out job |
| `messageId` | Optional | Non-empty string | Observed `data-message-id` for a legacy completed job (paired with `responseIndex`) |

`oracle_cancel` stops a queued or active job in the current project:

| Parameter | Required | Allowed values | What it does |
| --- | --- | --- | --- |
| `jobId` | Required | Job id | Queued or active job in the current project to cancel |

### Session footer

Interactive persisted sessions display an `oracle:` status item in the host footer.

| Footer text | Meaning |
| --- | --- |
| `oracle: unavailable` | Session has no persisted session file (`--no-session` or in-memory session) |
| `oracle: loaded` | Config loaded; the first background readiness check has not finished |
| `oracle: ready` | Prerequisites and transport passed; no active or queued jobs in this session |
| `oracle: auth needed` | Auth seed profile is missing/unreadable/unauthenticated, or `chatGptManagedProfileDir` is missing |
| `oracle: browser unavailable` | `chatGptRelayEndpoint` is unreachable, or Chrome holds the managed profile without DevTools |
| `oracle: config error` | `oracle.json` is invalid, or a local binary, path, or directory check failed |
| `oracle: running`, `oracle: running (N)` | One or `N` active jobs; appends `, <readiness>` unless readiness is `ready` |
| `oracle: queued`, `oracle: queued (N)` | One or `N` queued jobs; appends `, <readiness>` unless readiness is `ready` |
| `oracle: running (A), queued (Q)` | `A` active and `Q` queued jobs; appends `, <readiness>` unless readiness is `ready` |

## Driving oracle from a program

A program that dispatches and reads Oracle jobs (an automated script or batch runner) must invoke `/oracle-run` rather than asking a model to type the tool call, because a model that mistypes a path leaves a dispatch marker without a result file. `/oracle-run` executes the registered tool host-side with no model turn:

```bash
omp --cwd /abs/project -p --mode json --session-dir /abs/session "/oracle-run submit /abs/submit.request.json /abs/submit.result.json /abs/submit.marker.json"
```

- **Arguments and file safety:** Pass `<preflight|submit|read> <request.json> <result.json> [<marker.json>]` using three or four absolute paths (`<marker.json>` is optional on `submit` and `read`, and rejected on `preflight` with `A preflight dispatches nothing and takes no marker.`). Existing `<result.json>` (`Result already exists; inspect it before any further operation: <path>`) or `<marker.json>` files are never overwritten, so choose fresh paths per attempt.
- **Request fields:** `preflight` accepts optional `provider`, `followUpJobId`, `chatGptConversationId`; `submit` requires non-blank `prompt` and non-empty `files` and accepts optional `provider`, `preset`, `mode`, `followUpJobId`, `chatGptConversationId`; `read` requires non-blank `jobId` and accepts optional `projectId`, `action`, `responseIndex`, `messageId`. Unknown or missing fields fail before the marker or tool runs; valid requests normalize provider and mode aliases like a tool call.
- **Dispatch marker (`submit` and `read`):** Created with exclusive create (`wx`, mode `0600`) immediately before `execute`, containing `{"operation","dispatch_state":"may_have_been_sent","at"}`. If `/oracle-run` exits with no marker file, nothing was dispatched and you may retry safely; if the marker exists without a result file, inspect recent `oracle-<job-id>/job.json` and `prompt.md` files under `${PI_ORACLE_JOBS_DIR:-/tmp}` before retrying.
- **Result file:** `result.json` is written to a temporary file (`0600`) and renamed atomically with the tool's `{ content, details }` object; tool or job errors are recorded inside `details.error` or `details.job`, not as a non-zero exit code.
- **Summary line:** `/oracle-run` emits `{"operation","ok","jobId","status","ready","error"}` with only applicable fields, or `{"ok":false,"error":"..."}` without `operation` when validation fails before the tool finishes. Plain print mode (`-p` without `--mode json`) writes that single JSON line to `stdout`; `--mode json` (and `tui` or `rpc`) emits it inside an `oracle-command-output` custom message event.
- **Persisted session:** Submissions require `--session-dir`; wake-ups target that session, so print-mode callers read completion via `/oracle-run read` or `job.json`, never from a wake-up.

## Troubleshooting

Match what you see to the first action and recovery section below, or look up a machine-readable code under [Error codes](#error-codes).

| Symptom | First thing to do | Section |
| --- | --- | --- |
| `Oracle state directory ...; refusing to use it` | Set `PI_ORACLE_STATE_DIR` to a private directory you own | [State directory refusal](#oracle-refuses-the-state-directory) |
| `/oracle-auth` fails or says login is required | Confirm sign-in in `auth.chromeProfile`, then rerun `/oracle-auth` | [Auth fails or login required](#oracle-auth-fails-or-says-login-is-required) |
| Cookies synced (`Synced cookies from ...`) but session rejected | Quit the source browser completely and check cookie/keyring config | [Cookies synced but rejected](#cookies-synced-but-the-session-is-rejected) |
| Challenge or human verification page blocks a run | Solve the challenge in the browser; rerun `/oracle-auth` unless on relay | [Challenge page](#you-hit-a-challenge-or-verification-page) |
| `Oracle requires a persisted pi session` | Restart `omp` or `pi` without `--no-session` | [Persisted session required](#you-see-oracle-requires-a-persisted-pi-session) |
| Job finished on disk but no wake-up arrived | Run `/oracle-status` and `/oracle-read <job-id>` | [No wake-up arrived](#a-job-finished-but-no-wake-up-arrived) |
| `/oracle-clean` refuses a completed job | Wait until `Retry after ...`, then rerun `/oracle-clean` | [`/oracle-clean` grace](#oracle-clean-refuses-a-terminal-job-right-after-completion) |
| `agent-browser`, `tar`, `zstd`, or `cp` is missing or too old | Install or upgrade the binary (`agent-browser >= 0.41.2`) | [Missing or old dependency](#a-local-dependency-like-agent-browser-tar-or-zstd-is-missing) |
| `/oracle-auth` reads the wrong browser profile | Set `auth.chromeProfile` or `auth.chromeCookiePath` in agent `oracle.json` | [Wrong browser profile](#auto-detection-picked-the-wrong-browser-profile) |
| Deep Research fails with `deep_research_*` | Check `errorCode`, `chatUrl`, and `prompt-send-state` before retrying | [Deep Research failed](#a-deep-research-job-failed) |
| Completed job reads `collection-status: partial` or `failed` | Run `oracle_read({ jobId, action: "recollect" })`; do not resubmit | [Partial or failed collection](#a-completed-job-reads-collection-status-partial-or-failed) |
| Job failed with `Timed out waiting for ChatGPT response completion` | Run `oracle_read({ jobId, action: "recollect" })` before resubmitting | [May prompt have been sent?](#a-failed-job-may-the-prompt-have-been-sent) |
| Unsure whether a failed job sent its prompt | Check `prompt-send-state` in `oracle_read({ jobId })` | [May prompt have been sent?](#a-failed-job-may-the-prompt-have-been-sent) |
| Worker fails with `agent_browser_timeout` | Check `prompt-send-state` before retrying; adjust timeout if needed | [Driver command timed out](#a-driver-command-timed-out) |
| Leftover `.config` or `.target` driver session files | List active sessions with `agent-browser session list`, then remove absent ones | [Old session sidecars](#old-agent-browser-session-sidecars) |
| Another browser tool navigated an active job's tab | Check `/oracle-status` first; keep other tools off the active Chrome | [Managed Chrome driven](#do-not-drive-the-managed-chrome-while-jobs-run) |
| Prompt has draft text in front of it in relay mode | Clear the saved draft in Chrome's ChatGPT composer | [Draft prefix in relay mode](#the-prompt-arrived-with-unrelated-text-in-front-of-it-relay-mode) |
| Need full worker or auth logs for a failed run | Read `logs/worker.log` in the job dir or `oracle-auth.log` in `pi-oracle-auth-*` | [Inspect failure logs](#you-want-more-details-about-a-failed-run) |

### Oracle refuses the state directory

Oracle refuses `PI_ORACLE_STATE_DIR` (default `/tmp/pi-oracle-state`) when it is a symlink or, on POSIX, owned by another uid: `Oracle state directory <dir> is <a symlink | owned by uid N>; refusing to use it. Point PI_ORACLE_STATE_DIR at a private directory you own.` On multi-user machines, the first user of `/tmp/pi-oracle-state` owns it; never chmod, chown, or delete another user's state directory.

1. Stop your own Oracle sessions and workers.
2. Create a private state directory and export `PI_ORACLE_STATE_DIR` in the environment that starts `omp` or `pi`:
   ```bash
   mkdir -p "$HOME/.local/state/pi-oracle"
   chmod 700 "$HOME/.local/state/pi-oracle"
   export PI_ORACLE_STATE_DIR="$HOME/.local/state/pi-oracle"
   ```
3. Restart the host with that environment; `PI_ORACLE_JOBS_DIR` and existing job paths stay unchanged, and the session footer clears the error.

Oracle also ignores job directories that are symlinks, owned by another uid (such as jobs created under `sudo`), or writable by group or others. Restore `0700` on your own job directories and `0600` on their `job.json` files only after verifying their ownership and contents.

### `/oracle-auth` fails or says login is required

`/oracle-auth` fails when the selected browser profile has no valid provider session cookies or cannot decrypt them.

1. Open the browser profile named by `auth.chromeProfile` and confirm ChatGPT or Grok is signed in there.
2. If you use a custom Chromium cookie source, verify `auth.chromeCookiePath` points at that profile's `Cookies` SQLite database; on macOS verify `auth.chromiumKeychain.services`, and on Linux leave `auth.chromiumKeychain` unset and configure `SWEET_COOKIE_LINUX_KEYRING` or the browser's safe-storage password variable ([Linux](#linux)).
3. If the provider is half-signed-in or waiting on human verification, complete sign-in in the headed auth browser or managed Chrome and rerun `/oracle-auth` (or call `oracle_auth({})` once); in relay mode, complete sign-in directly in the relay Chrome and resubmit without running `/oracle-auth`.

<a id="custom-chromium-auth-says-cookies-synced-but-the-session-is-rejected"></a>
### Cookies synced but the session is rejected

`/oracle-auth` can log `Synced cookies from ...` (on default Chrome, Linux Chromium, or custom macOS Chromium) while the provider rejects the imported cookies because the source database was unflushed or decrypted with the wrong key.

1. Open the configured browser profile and confirm ChatGPT or Grok loads signed in without prompting.
2. Quit that browser completely so its `Cookies` database and `Cookies-wal` / `Cookies-shm` sidecars flush to disk.
3. If `auth.chromeCookiePath` is set in agent-level `oracle.json`, confirm it points to that profile's `Cookies` file.
4. On macOS, confirm `auth.chromiumKeychain.services` matches the browser's Keychain item; on Linux, confirm `secret-tool`, `kwallet-query`, or the matching `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable is configured.
5. Rerun `/oracle-auth` and check that it prints `Oracle auth synced.`

### You hit a challenge or verification page

Provider bot or human verification blocks automated navigation until solved interactively.

1. Complete the verification challenge in the headed auth browser window (or directly in the relay or managed Chrome window).
2. On the isolated seed profile or managed browser, rerun `/oracle-auth` and confirm `oracle: ready` before submitting again; in relay mode, resubmit directly once the challenge clears in Chrome.

### You see "Oracle requires a persisted pi session"

Oracle requires an on-disk session file so detached workers know which session owns wake-up delivery (`persisted_session_required`).

1. Exit the `--no-session` run (`omp --no-session` or `pi --no-session`).
2. Start a normal persisted session (or pass `--session-dir <dir>` in print mode) and run `/oracle` again.

### A job finished but no wake-up arrived

Wake-ups are best-effort messages sent at most three times (`0 s`, `15 s`, and `60 s` apart) and only while the asking session is idle with no queued messages, while the job directory holds the durable result.

1. Run `/oracle-status` to inspect the latest job and list recent job ids for the project.
2. Run `/oracle-read <job-id>` (or `oracle_read({ jobId })`) to read the saved answer; this also stops further wake-up attempts for the job. If the job was submitted from another project, follow [Read a job from another project](#read-a-job-from-another-project). To inspect UI model provenance, see [See which model a job used](#see-which-model-a-job-used).

### `/oracle-clean` refuses a terminal job right after completion

`/oracle-clean` blocks deletion during the `2`-minute (`120000` ms) post-send retention grace window after a wake-up attempt (and while a `60`-second notification claim or worker PID is live) so an awakened turn never reads a deleted path.

1. Note the `Retry after <timestamp>` time printed by `/oracle-clean`.
2. Wait until that timestamp passes, then rerun `/oracle-clean <job-id|all>`.

### A local dependency like `agent-browser`, `tar`, or `zstd` is missing

Preflight and worker startup check required CLI binaries (`local_dependency_missing`) and enforce `agent-browser` `0.41.2` or newer (`agent_browser_unsupported` in the worker):

```text
Oracle prerequisite agent-browser is too old: found X.Y.Z at <path>, need 0.41.2 or newer. Upgrade agent-browser (npm install -g agent-browser@latest or brew upgrade agent-browser) and retry.
```

If `--version` cannot be parsed, preflight reports `agent-browser version could not be determined` with the same floor.

1. Install any missing binary (`agent-browser`, `tar`, `zstd` for ChatGPT, or `cp` on macOS `apfs-clone`) on `PATH`, or point `AGENT_BROWSER_PATH` / `PI_ORACLE_CP_PATH` at it.
2. Run `<path> --version` on the selected `agent-browser` binary and upgrade that exact installation (`npm install -g agent-browser@latest` or `brew upgrade agent-browser`; when `AGENT_BROWSER_PATH` is set, upgrade that path rather than another copy on `PATH`).
3. Rerun your command; readiness caches `agent-browser` checks by resolved path, modification time, and file size, so an upgraded binary is picked up automatically.

### Auto-detection picked the wrong browser profile

Default profile discovery selects the last-used or `Default` profile, which may not hold your signed-in provider account.

1. Set `auth.chromeProfile` (plus `auth.chromeCookiePath`, and `auth.chromiumKeychain` on macOS for custom Chromium browsers) in your agent-level `oracle.json`.
2. Rerun `/oracle-auth` and verify that cookies import from the intended profile.

<a id="a-deep-research-job-ended-with-deep_research_report_unreadable"></a>
### A Deep Research job failed

Failed Deep Research jobs record one of three `errorCode` values in `job.json` and `oracle_read`:

- **`deep_research_report_unreadable`:** The worker could not read the widget frame because the job used the isolated seed profile instead of shared Chrome, the frame did not attach within 60 seconds, or research hit `worker.completionTimeoutMs` (90 minutes). Check `prompt-send-state` in `oracle_read({ jobId })`, open `chatUrl` in Chrome rather than resending, and set `browser.chatGptRelayEndpoint` or `browser.chatGptManagedProfileDir` before the next run.
- **`deep_research_clarification_requested`:** ChatGPT replied with a plain assistant turn (quoted in `error`, such as clarifying questions) instead of starting the research widget. Restate the prompt with explicit assumptions and "do not ask clarifying questions", then submit a new job.
- **`deep_research_toggle_not_found`:** The composer `Add files and more` menu was missing or covered for 10 seconds, lacked a Deep Research entry, or did not show the Deep Research pill after selection. Confirm your ChatGPT account has Deep Research available on a standard chat page, then rerun `/oracle`.

### A completed job reads `collection-status: partial` or `failed`

Provider generation finished (`status: "complete"`, `generation-status: completed`), so do not resubmit the prompt. `collection-required-missing` (`bound_response_capture`, `rich_response_fidelity`, `unresolved_source_links`, `redacted_transport_links`) means `response.md` is degraded or missing; `collection-optional-missing` (`native_markdown_export`, `artifact:<id>`) means a secondary download failed while `response.md` is intact; `recollection-needed` means no `response.md` was saved.

1. Confirm the job's sign-in transport is available (for example, keep relay Chrome open), then ask the agent to run `oracle_read({ jobId: "<job-id>", action: "recollect" })` or invoke `/oracle-run read` (adding `responseIndex` and `messageId` together only for legacy jobs without a turn binding).
2. Inspect the updated `collection-status` and `response.md`; Oracle opens a fresh browser session, reacquires the bound turn (by `messageId`, content hash, or the user turn carrying `context-<job-id>.tar.zst`), and for Deep Research re-triggers **Export → Export to Markdown** into `artifacts/<sha256>-<file name>` (Chrome also keeps a copy in its own download directory) or falls back to widget Markdown with citation footnotes.

### A failed job: may the prompt have been sent?

Failed jobs record `promptSendState` in `job.json` (`prompt-send-state` in `oracle_read`) so you can avoid sending duplicate prompts.

1. Run `oracle_read({ jobId: "<job-id>" })` or `/oracle-status <job-id>` and check `prompt-send-state`.
2. Act on its value: if `not_sent`, nothing reached the provider and resubmitting is safe; if `attempted`, open `chatUrl` in Chrome to check the thread before resubmitting; if `accepted`, open `chatUrl` in Chrome to inspect the reply or pass `chatGptConversationId` to continue that ChatGPT conversation without resending the original prompt.
3. If an `accepted` job failed with `Timed out waiting for ChatGPT response completion`, run `oracle_read({ jobId: "<job-id>", action: "recollect" })` first. It waits for the bound reply to finish before collecting it and marking the job `complete`, without sending anything. A failed wait keeps the original failure; see [Recollect a finished answer](#recollect-a-finished-answer) for the deadline and receipt. If 0.4.15 recollected a reply after a timeout, check that the saved reply is complete: that version did not verify completion.

### A driver command timed out

`errorCode: agent_browser_timeout` means one bounded `agent-browser` command exceeded its deadline, distinct from the 3-minute stale-heartbeat check (which fails an active job when its worker stops updating `heartbeatAt` for 3 minutes) and from `agent_browser_unsupported` (raised at worker startup when `agent-browser` is older than `0.41.2`).

Default driver commands time out at 60 seconds (`PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS`, clamped to 5000–150000 ms), `open` at `90 s`, `connect` at `30 s`, `batch` prompt insertion at `120 s`, status and diagnostics at `15 s`, and artifact downloads at `90 s` (`105 s` for in-page byte capture).

1. Check `prompt-send-state` in `oracle_read({ jobId })` first, because the worker never retries a timed-out send (`attempted` means the provider may have received it; a composer digest mismatch leaves `not_sent`).
2. If slow local browser responses caused a non-send timeout, set `PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS` (up to 150000 ms) before retrying.

### Old agent-browser session sidecars

Earlier releases could leave conversation URLs in `<session>.target` files under the driver socket directory; session teardown deletes `<session>.config` and `<session>.target` once `agent-browser` confirms a session is absent, without sweeping historical files.

1. Run `/oracle-status` and confirm no Oracle jobs or `/oracle-auth` runs are active.
2. Run `agent-browser session list` in a shell, and stop immediately if that command fails.
3. Locate the driver socket directory: `AGENT_BROWSER_SOCKET_DIR`, else `XDG_RUNTIME_DIR/agent-browser`, else `~/.agent-browser` (or `agent-browser` under the system temporary directory only when no home directory exists); if `AGENT_BROWSER_NAMESPACE` is set, open its sanitized `namespaces/<namespace>/run` subdirectory.
4. For each old Oracle session (`<sessionPrefix>-auth` or `<sessionPrefix>-<runtimeId>`) that is **not** listed by `agent-browser session list`, remove only `<session>.config` and `<session>.target` in that directory; never remove listed sessions, another tool's files, or whole driver directories.

### Do not drive the managed Chrome while jobs run

Connecting another browser automation tool (such as a general CDP browser tool) to the managed or relay Chrome adopts its visible tab and can navigate a running job's tab away from its conversation, forcing the worker to reopen the chat and reattach any Deep Research frame.

1. Run `/oracle-status` to confirm no job is `running` before attaching another automation tool to that Chrome endpoint.
2. Inspect active conversations in a separate browser window rather than driving the job's Chrome over CDP.

### The prompt arrived with unrelated text in front of it (relay mode)

ChatGPT restores saved composer drafts inside a signed-in Chrome profile; the worker clears the composer before insertion and verifies normalized character length and SHA-256 before send, failing the job with `nothing was sent` if a restored draft alters the editor text.

1. Open ChatGPT in the relay Chrome window and clear any saved draft in the composer.
2. Inspect `logs/worker.log` and the `logs/<reason>.url.txt` and `.snapshot.txt` files in the job directory, then resubmit the job.

### You want more details about a failed run

Every worker and `/oracle-auth` run writes private local logs and page snapshots on failure.

1. For a failed job, open `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` and read `job.json`, `logs/worker.log`, and any `logs/<reason>.url.txt`, `logs/<reason>.snapshot.txt`, `logs/<reason>.body.txt`, `logs/<reason>.signals.txt`, and `logs/<reason>.png` files.
2. For a failed `/oracle-auth` run, open the `pi-oracle-auth-*` directory under the system temporary directory (use the exact path `/oracle-auth` printed) and inspect `oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, `oracle-auth.body.txt`, and `oracle-auth.png`.

## Error codes

Failed tool calls return `details.error.code`, and failed worker runs (marked `Worker:` below) record `errorCode` in `job.json` and `oracle_read`.

| Code | Raised when | What to do |
| --- | --- | --- |
| `invalid_preset` | `oracle_submit` receives an unknown `preset` | Retry with a canonical preset id, or omit `preset` |
| `persisted_session_required` | Host has no session file (`--no-session`) | Start a persisted session and retry ([Persisted session](#you-see-oracle-requires-a-persisted-pi-session)) |
| `auth_seed_profile_missing` | `browser.authSeedProfileDir` does not exist | Run `/oracle-auth` or `oracle_auth` once ([Auth fails](#oracle-auth-fails-or-says-login-is-required)) |
| `auth_seed_profile_unreadable` | `browser.authSeedProfileDir` lacks read/traverse permissions | Fix permissions or rerun `/oracle-auth` ([Auth fails](#oracle-auth-fails-or-says-login-is-required)) |
| `auth_seed_profile_invalid_type` | `browser.authSeedProfileDir` is not a directory | Remove the invalid path or rerun `/oracle-auth` ([Auth fails](#oracle-auth-fails-or-says-login-is-required)) |
| `auth_seed_profile_unauthenticated` | Seed directory lacks `.oracle-seed-generation` | Run `/oracle-auth` or `oracle_auth` to verify seed ([Auth fails](#oracle-auth-fails-or-says-login-is-required)) |
| `oracle_config_invalid` | `oracle.json` fails parse, schema, or project-scope rules | Fix `oracle.json` keys and values ([Config files](#config-files)) |
| `browser_executable_missing` | Configured `browser.executablePath` does not exist | Fix `browser.executablePath` or install Chrome there |
| `browser_executable_not_executable` | `browser.executablePath` is not an executable file | Fix permissions or point `browser.executablePath` at Chrome |
| `local_dependency_missing` | `agent-browser`, `tar`, `zstd`, or `cp` not found | Install the missing binary or set its path variable ([Missing dependency](#a-local-dependency-like-agent-browser-tar-or-zstd-is-missing)) |
| `oracle_profile_path_unsafe` | Seed or runtime dir is inside a real browser profile | Move `authSeedProfileDir` and `runtimeProfilesDir` outside real browser roots |
| `runtime_profiles_dir_unwritable` | `browser.runtimeProfilesDir` cannot be created or written | Fix permissions or set a writable `browser.runtimeProfilesDir` |
| `jobs_dir_unwritable` | `PI_ORACLE_JOBS_DIR` cannot be created or written | Fix `PI_ORACLE_JOBS_DIR` permissions or set a writable directory |
| `relay_unavailable` | `browser.chatGptRelayEndpoint` fails `/json/version` check | Start the relay Chrome or fix `chatGptRelayEndpoint`; never call `oracle_auth` ([Relay](#existing-chrome-relay-chatgpt-only)) |
| `managed_browser_profile_missing` | `browser.chatGptManagedProfileDir` does not exist | Run `/oracle-auth` to open and sign into managed Chrome ([Managed browser](#managed-chatgpt-browser-dedicated-account)) |
| `managed_browser_in_use` | Chrome holds managed profile without Oracle's DevTools port | Quit that Chrome window and retry ([Managed browser](#managed-chatgpt-browser-dedicated-account)) |
| `archive_input_required` | `oracle_submit` `files` array is empty | Pass at least one project-relative path in `files` |
| `archive_input_blank` | An entry in `files` is blank or whitespace | Pass non-empty project-relative paths (or `"."` for whole repo) |
| `archive_input_whole_repo_sentinel_invalid` | `files` entry resolves to project root without being `"."` | Pass `"."` for whole repo, or an exact relative path |
| `archive_input_too_broad` | `files` is `["."]` and the project root is the home directory, above it, or the filesystem root | Name the files or directories of the project the request is about, or start the session in the project directory |
| `archive_input_missing` | A path in `files` does not exist in the project | Retry with an existing path relative to the project root |
| `archive_input_outside_project` | A path in `files` resolves outside the project root | Retry with a path inside the current project |
| `archive_input_symlink_escape` | Real path of a `files` entry escapes the project via symlink | Retry with a path whose real target stays inside the repo |
| `oracle_thread_target_conflict` | Both `followUpJobId` and `chatGptConversationId` were passed | Pass either `followUpJobId` or `chatGptConversationId`, not both |
| `invalid_chatgpt_conversation_id` | `chatGptConversationId` is blank or malformed | Pass a valid conversation id or `https://chatgpt.com/c/...` URL, or omit it |
| `follow_up_job_not_found` | `followUpJobId` does not match a trusted job | Retry with a completed job id from this project |
| `follow_up_job_wrong_project` | `followUpJobId` belongs to another project | Retry with a follow-up job id from the current project |
| `follow_up_job_not_complete` | `followUpJobId` is not in `complete` status | Wait for the earlier job to finish, then retry |
| `follow_up_job_missing_chat_url` | Completed `followUpJobId` has no saved `chatUrl` | Retry with a completed job that recorded a `chatUrl` |
| `job_not_found` | `jobId` is absent (or outside current project on cancel) | Run `/oracle-status` to find a valid job id |
| `job_wrong_project` | `oracle_read` queried another project's job without `projectId` | Retry with the reported owning `projectId` ([Another project](#read-a-job-from-another-project)) |
| `archive_too_large` | Compressed archive exceeds `250 MiB` (ChatGPT) or `200 MiB` (Grok) | Retry once with fewer or narrower `files` paths |
| `<tool>_failed` | Uncaught tool error (`oracle_submit_failed`, `oracle_read_failed`, etc.) | Read `details.error.message`, fix the reported cause, and retry |
| `agent_browser_timeout` | Worker: `agent-browser` command exceeded its timeout | Check `prompt-send-state` before retrying ([Driver command timed out](#a-driver-command-timed-out)) |
| `agent_browser_unsupported` | Worker: `agent-browser` older than `0.41.2` or unreadable | Upgrade `agent-browser` to `0.41.2`+ and retry ([Missing dependency](#a-local-dependency-like-agent-browser-tar-or-zstd-is-missing)) |
| `managed_browser_changed` | Worker: another browser replaced managed Chrome on its port | Resubmit to reopen the managed profile ([Managed browser](#managed-chatgpt-browser-dedicated-account)) |
| `deep_research_toggle_not_found` | Worker: `Add files and more` menu or Deep Research pill failed | Confirm Deep Research access on a standard chat ([Deep Research failed](#a-deep-research-job-failed)) |
| `deep_research_clarification_requested` | Worker: model replied with text instead of starting research | Restate prompt with explicit assumptions and resubmit ([Deep Research failed](#a-deep-research-job-failed)) |
| `deep_research_report_unreadable` | Worker: isolated runtime, unattached frame, or timeout | Check `prompt-send-state` and `chatUrl`; use shared Chrome ([Deep Research failed](#a-deep-research-job-failed)) |

## Configuration reference

Defaults and validation are defined by `DEFAULT_CONFIG` and `validateOracleConfig` in [`extensions/oracle/lib/config.ts`](../extensions/oracle/lib/config.ts). Project config files may set only `defaults`, `worker`, `poller`, `artifacts`, and `cleanup`; `browser` and `auth` are agent-level only.

In the example below, `~/.omp/agent/...`, `"apfs-clone"`, and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` illustrate an Oh My Pi installation on macOS; runtime defaults adapt to the active host and platform:

```json
{
  "defaults": { "provider": "chatgpt", "preset": "pro_extended", "grokMode": "heavy" },
  "browser": {
    "sessionPrefix": "oracle",
    "authSeedProfileDir": "~/.omp/agent/extensions/oracle-auth-seed-profile",
    "runtimeProfilesDir": "~/.omp/agent/extensions/oracle-runtime-profiles",
    "maxConcurrentJobs": 2,
    "cloneStrategy": "apfs-clone",
    "chatUrl": "https://chatgpt.com/",
    "authUrl": "https://chatgpt.com/auth/login",
    "runMode": "headless",
    "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "args": ["--disable-blink-features=AutomationControlled"]
  },
  "auth": { "pollMs": 1000, "bootstrapTimeoutMs": 600000, "chromeProfile": "Default" },
  "worker": { "pollMs": 5000, "completionTimeoutMs": 5400000 },
  "poller": { "intervalMs": 5000 },
  "artifacts": { "capture": true },
  "cleanup": { "completeJobRetentionMs": 1209600000, "failedJobRetentionMs": 2592000000 }
}
```

### `defaults` (agent or project)

`defaults` selects the provider, ChatGPT preset, and Grok mode when a command or tool omits them.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `defaults.provider` | `"chatgpt"` | `"chatgpt"` \| `"grok"` | Default provider for `oracle_submit`, `oracle_preflight`, and `/oracle-auth` |
| `defaults.preset` | `"pro_extended"` | Preset id in `ORACLE_SUBMIT_PRESETS` | Default ChatGPT preset when `oracle_submit` omits `preset` |
| `defaults.grokMode` | `"heavy"` | `"heavy"` | Grok execution mode when provider is `"grok"` |

Allowed `defaults.preset` ids ([Providers and presets](../README.md#providers-and-presets)): `"pro_standard"`, `"pro_extended"`, `"thinking_light"`, `"thinking_standard"`, `"thinking_extended"`, `"thinking_heavy"`, `"instant"`, `"instant_auto_switch"`, `"deep_research"`.

### `browser` (agent-level only)

`browser` controls profile directories, concurrency, transport endpoints, and Chrome launch flags.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `browser.sessionPrefix` | `"oracle"` | Non-empty `^[\p{L}\p{N}_-]+$` | Prefix for `agent-browser` session names (`<sessionPrefix>-auth`, `<sessionPrefix>-<runtimeId>`) |
| `browser.authSeedProfileDir` | `<agent dir>/extensions/oracle-auth-seed-profile` | Safe absolute path (`~` expanded) | Isolated seed profile populated by `/oracle-auth` (`-grok` appended for Grok) |
| `browser.runtimeProfilesDir` | `<agent dir>/extensions/oracle-runtime-profiles` | Safe absolute path (`~` expanded) | Parent directory for per-job cloned runtime profiles |
| `browser.maxConcurrentJobs` | `2` | Integer `1`–`32` | Maximum active jobs at once; also scales queue limits |
| `browser.cloneStrategy` | `"apfs-clone"` (macOS), `"copy"` (Linux, Windows) | `"apfs-clone"` \| `"copy"` | Seed clone method (`cp -cR` on macOS vs recursive copy) |
| `browser.chatUrl` | `"https://chatgpt.com/"` | `https://chatgpt.com` or `https://chat.openai.com` URL | Entry URL for fresh ChatGPT chats (ignored on Grok, which uses `"https://grok.com/"`) |
| `browser.authUrl` | `"https://chatgpt.com/auth/login"` | `https://chatgpt.com` or `https://chat.openai.com` URL | Entry URL for ChatGPT sign-in (ignored on Grok, which uses `"https://grok.com/"`) |
| `browser.runMode` | `"headless"` | `"headless"` \| `"headed"` | Launch mode for isolated runtime browsers (managed Chrome is always headed) |
| `browser.chatGptRelayEndpoint` | `undefined` | Loopback `http://` origin, no path/query/auth | Opt-in ChatGPT CDP relay or persistent Chrome endpoint |
| `browser.chatGptManagedProfileDir` | `undefined` | Safe absolute path (`~` expanded) | Opt-in Oracle-managed Chrome user-data directory for ChatGPT |
| `browser.executablePath` | Auto-detected on macOS and Linux; `undefined` on Windows | Optional absolute path (`~` expanded) | Chrome or Chromium binary for isolated, managed, and auth browsers |
| `browser.userAgent` | Auto-detected on macOS only; `undefined` on Linux and Windows | Optional non-empty string | User-Agent string passed to isolated runtime browsers |
| `browser.args` | `["--disable-blink-features=AutomationControlled"]` | Array of non-empty strings | Extra Chromium launch flags for isolated, managed, and auth browsers |

Validation rules on `browser` keys:

- **Session prefix and legacy keys:** `browser.sessionPrefix` accepts only Unicode letters, Unicode numbers, `-`, and `_` (`^[\p{L}\p{N}_-]+$`), rejecting dots, spaces, and path separators at config load. Do not set the legacy keys `browser.sessionName` or `browser.profileDir`: defaults populate `sessionPrefix` and `authSeedProfileDir` before legacy mapping runs, so those legacy keys have no effect.
- **Safe profile paths:** `authSeedProfileDir`, `runtimeProfilesDir`, and `chatGptManagedProfileDir` may not be `/`, `$HOME`, inside a known real browser user-data directory or configured cookie source root, or overlapping one another.
- **Queue limits:** `browser.maxConcurrentJobs` caps active jobs at `N`, queued jobs at `N`, and queued plus retained pre-submit archive bytes at `N` × `250 MiB`.
- **Relay origin and exclusivity:** `browser.chatGptRelayEndpoint` accepts only `http://` origins on `127.0.0.1`, `localhost`, or `[::1]` with no credentials, path, query, or hash, and cannot be set alongside `browser.chatGptManagedProfileDir`.
- **Executable and User-Agent detection:** `browser.executablePath` checks `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS and `PATH` on Linux, and must be set explicitly when auto-detection finds nothing (including on Windows) before launching isolated or managed browsers. `browser.userAgent` is derived from `<executable> --version` only for the default macOS Chrome binary when `browser.userAgent` is unset in config.
- **Protected launch flags:** when Oracle launches an isolated job browser or the managed browser, it refuses a `browser.args` entry that sets `--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, or `--remote-allow-origins` (with a `--`, `-`, or `/` prefix). Config loading does not check these flags.

### `auth` (agent-level only)

`auth` configures `/oracle-auth` polling, timeouts, and local cookie import sources.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `auth.pollMs` | `1000` (`1 s`) | Integer `>= 100` | Poll interval in ms while `/oracle-auth` waits for sign-in |
| `auth.bootstrapTimeoutMs` | `600000` (`10 minutes`) | Integer `>= 1000` | Timeout in ms for `/oracle-auth` sign-in or challenge completion |
| `auth.chromeProfile` | Auto-detected (`"Default"` or Linux profile path) | Non-empty string | Browser profile name, profile directory, or `Cookies` DB path |
| `auth.chromeCookiePath` | `undefined` | Optional absolute path (`~` expanded) | Explicit path to a Chromium `Cookies` SQLite database |
| `auth.chromiumKeychain` | `undefined` | `{ account, services, label? }` (macOS only) | Keychain safe-storage descriptor; requires non-empty `services` and `auth.chromeCookiePath` |

### `worker` (agent or project)

`worker` sets generation polling and overall completion deadlines for detached job workers.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `worker.pollMs` | `5000` (`5 s`) | Integer `>= 100` | Poll interval in ms while waiting for provider generation |
| `worker.completionTimeoutMs` | `5400000` (`90 minutes`) | Integer `>= 1000` | Maximum ms a worker waits for generation or Deep Research |

### `poller` (agent or project)

`poller` sets how often a persisted host session checks job status, readiness, and wake-ups.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `poller.intervalMs` | `5000` (`5 s`) | Integer `>= 100` | Host-session background poller interval in ms |

### `artifacts` (agent or project)

`artifacts` controls whether the worker downloads files attached to a completed provider turn.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `artifacts.capture` | `true` | `true` \| `false` | Whether the worker downloads response artifacts into `artifacts/` |

### `cleanup` (agent or project)

`cleanup` sets age-based pruning windows for terminal job directories.

| Key | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `cleanup.completeJobRetentionMs` | `1209600000` (`14 days`) | Integer `>= 0` | Retention window in ms for `complete` and `cancelled` job directories |
| `cleanup.failedJobRetentionMs` | `2592000000` (`30 days`) | Integer `>= 0` | Retention window in ms for `failed` job directories |

## Environment variables

Set these variables in the environment of `omp` or `pi` when overriding paths, driver timeouts, or Linux cookie decryption.

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_ORACLE_JOBS_DIR` | `/tmp` | Root directory for `oracle-<job-id>/` job directories |
| `PI_ORACLE_STATE_DIR` | `/tmp/pi-oracle-state` | Private root for locks, queue/runtime/conversation leases, and keeper log |
| `PI_ORACLE_CP_PATH` | `cp` on `PATH` | `cp` binary used on macOS when `browser.cloneStrategy` is `"apfs-clone"` |
| `PI_ORACLE_AGENT_BROWSER_TIMEOUT_MS` | `60000` | Default worker driver timeout in ms (clamped `5000`–`150000`) |
| `PI_ORACLE_NODE_PATH` | `process.execPath` (when `node`) or `node` | Node executable that spawns detached workers |
| `PI_ORACLE_MANAGED_BROWSER_IDLE_MS` | `120000` (`2 minutes`) | Idle grace in ms before the keeper quits an Oracle-started Chrome |
| `PI_ORACLE_AUTH_AGENT_BROWSER_TIMEOUT_MS` | `30000` | `/oracle-auth` `agent-browser` command timeout in ms |
| `PI_ORACLE_AUTH_CLOSE_TIMEOUT_MS` | `10000` | `/oracle-auth` browser close timeout in ms |
| `PI_ORACLE_AUTH_KILL_GRACE_MS` | `2000` | `/oracle-auth` subprocess kill grace in ms |
| `PI_ORACLE_AUTH_COOKIE_READ_TIMEOUT_MS` | `30000` | `/oracle-auth` cookie read timeout in ms |
| `PI_CODING_AGENT_DIR` | Host agent dir (`~/.pi/agent` fallback) | Overrides the host agent dir (`~/.omp/agent` or `~/.pi/agent`) for config, profiles, and trust |
| `AGENT_BROWSER_PATH` | Homebrew, `/usr/local/bin`, or `PATH` | Overrides the `agent-browser` executable path (`/opt/homebrew/bin/agent-browser` checked first) |
| `AGENT_BROWSER_SOCKET_DIR` | `XDG_RUNTIME_DIR/agent-browser` or `~/.agent-browser` | Explicit `agent-browser` socket and session-sidecar directory |
| `AGENT_BROWSER_NAMESPACE` | Unset | Scopes driver sockets and sidecars under `namespaces/<namespace>/run` |
| `XDG_RUNTIME_DIR` | OS session runtime dir | Fallback parent for `agent-browser` sockets when `AGENT_BROWSER_SOCKET_DIR` is unset |
| `XDG_CONFIG_HOME` | `~/.config` | Linux config root searched when auto-detecting browser profiles |
| `SWEET_COOKIE_LINUX_KEYRING` | Unset | Sweet Cookie Linux keyring backend (`gnome`, `kwallet`, or `basic`) |
| `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` | Unset | One-run safe-storage password override (`CHROME`, `CHROMIUM`, `BRAVE`, `EDGE`); scrubbed from subprocesses |

`AGENT_BROWSER_PATH` defaults to the first existing binary among `/opt/homebrew/bin/agent-browser` and `/usr/local/bin/agent-browser`, falling back to `agent-browser` on `PATH`. `PI_CODING_AGENT_DIR` overrides the agent directory read by `getAgentDir()` on both hosts, and acts as the `~/.pi/agent` fallback in the auth worker when host `configLoad` metadata is absent.

Safe-storage override variable names are `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`, `SWEET_COOKIE_BRAVE_SAFE_STORAGE_PASSWORD`, and `SWEET_COOKIE_EDGE_SAFE_STORAGE_PASSWORD`; every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable is removed from child-process environments before browser, helper, or archive commands run.

Runtime variable names retain upstream's `PI_ORACLE_` prefix for compatibility. Validation and release scripts also read `PI_ORACLE_PROOF_*`, `PI_ORACLE_CHATGPT_PRESET_PROOF*`, `PI_ORACLE_REAL_TEST_*`, `PI_ORACLE_SMOKE_*`, and `PLATFORM_SMOKE_*`; see [Which check to run](TEST_PLAN.md#which-check-to-run), [Real runtime suite auth and switches](PLATFORM_SMOKE.md#real-runtime-suite-auth-and-switches), and [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof).

## Switch install source

Switch between the published npm package, GitHub `main`, and a linked local checkout without leaving duplicate command registrations.

If upstream `pi-oracle` is installed, remove it first on Oh My Pi (`omp`) or `pi` so `/oracle` and the `oracle_*` tools register once:

```bash
omp plugin uninstall pi-oracle
pi remove npm:pi-oracle
```

### Published npm release

1. On Oh My Pi, if `omp-oracle` is linked to a local checkout, uninstall it first. `omp plugin install omp-oracle@<version>` reports success but leaves the checkout symlink in place and keeps reporting the checkout's version:
   ```bash
   omp plugin uninstall omp-oracle
   ```
2. Install the published registry package (`omp` for Oh My Pi, `pi` for `pi`):
   ```bash
   omp install omp-oracle
   pi install npm:omp-oracle
   ```
   Restart or reload the host session to load the registry release.

### Track `main` from GitHub

1. Install directly from the GitHub repository (`omp` or `pi`):
   ```bash
   omp install https://github.com/alphastorm/omp-oracle
   pi install https://github.com/alphastorm/omp-oracle
   ```
2. Pull newer commits later by rerunning `omp install --force https://github.com/alphastorm/omp-oracle` on Oh My Pi or `pi update --extensions` on `pi`.

### Link a local checkout

1. Clone the repository and link it into your host (`omp` or `pi`):
   ```bash
   git clone https://github.com/alphastorm/omp-oracle
   omp install ./omp-oracle
   pi install -l ./omp-oracle
   ```
   When switching Oh My Pi back to a registry release later, run `omp plugin uninstall omp-oracle` before `omp install omp-oracle`, because `omp plugin install omp-oracle@<v>` alone leaves the checkout symlink in place. For isolated contributor sessions that load a checkout without touching your normal agent state, see [Isolated `pi` session smoke](TEST_PLAN.md#isolated-pi-session-smoke).

## Upgrade notes

Behavior changes across releases that affect existing local state or scripts:

- **`0.4.14` — Job directory ownership and permissions:** Jobs created under another uid (for example via `sudo`), symlinked jobs, and jobs with group/world write permissions are now ignored rather than read or promoted.
- **`0.4.14` — Driver session sidecar cleanup:** New teardown removes each absent session's `.config` and `.target`; old releases may have left conversation URLs in `.target` files.
- **`0.4.7` — Linux Chromium keyring and password override:** Before `omp-oracle` moved to Sweet Cookie 0.4, Chromium profiles used Chrome's keyring entry and override. Use `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD` (rather than `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD`) for Linux Chromium profiles.
