# OMP Oracle security model

This page is for operators and security reviewers checking what OMP Oracle, published on npm as `omp-oracle`, sends off the machine, who can reach provider credentials, and where the trust boundaries sit in the coding-agent hosts Oh My Pi (OMP) and `pi`.

Companion guides: [Set up a transport](OPERATIONS.md#set-up-a-transport) · [Config files](OPERATIONS.md#config-files) · [Compatibility](COMPATIBILITY.md) · [Architecture](ARCHITECTURE.md) · [Security policy](../SECURITY.md).

## What leaves the machine

Each job, meaning one submitted request, sends your prompt and one archive of selected project files to the provider (`chatgpt.com` for ChatGPT, `grok.com` for Grok), through the provider's web app in a local browser, under your own account.

When you run `/oracle` or `/oracle-followup`, the host agent chooses the `files` paths. The dispatch prompt tells it to archive the whole project for a broad request, and the target files plus nearby code for a narrow one. Name the paths in your request to control what is archived.

OMP Oracle adds no telemetry, analytics, or hosted control plane; the browser makes the ordinary web requests required to load and run the provider's web app. Archives have a per-provider upload ceiling: `250 MiB` as `.tar.zst` for ChatGPT, and `200 MiB` as `.tar.gz` for Grok. Oversize selections are pruned locally (for whole-repo `.` inputs) or rejected locally with `archive_too_large` before a job is created; nothing is partially uploaded.

Prompts travel to `agent-browser`, the local browser-automation CLI, on standard input rather than command-line arguments: ChatGPT uses JSON `batch` input and Grok uses `eval --stdin` (with `AGENT_BROWSER_NO_WEBMCP=1` and `AGENT_BROWSER_NO_VERSION_CHECK=1`; see [Driver execution and prompt insertion](ARCHITECTURE.md#driver-execution-and-prompt-insertion)). Keeping prompts off process arguments avoids per-argument OS limits and hides prompt text from local process listings.

On ChatGPT, the detached job worker compares the normalized character length and SHA-256 of the composer editor against the prompt before clicking send and aborts on a mismatch; Grok fills via `eval --stdin` without a post-fill SHA-256 check.

### Default exclusions

When `oracle_submit` expands a whole-repo `.` selection or a directory input, it leaves out default exclusions (paths skipped automatically by directory or file name):

- Directories excluded anywhere in the tree: `.git`, `.hg`, `.svn`, `.pi`, `.omp`, `.oracle-context`, `.cursor`, `.artifacts`, `.crabbox`, `node_modules`, `target`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.nox`, `.hypothesis`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.cache`, `.gradle`, `.terraform`, `DerivedData`, `.build`, `.pnpm-store`, `.serverless`, `.aws-sam`, `secrets`, `.secrets`, and `.yarn/cache`.
- Directories excluded at the project root: `coverage`, `htmlcov`, `tmp`, `temp`, `.tmp`, `dist`, `build`, and `out`.
- Files excluded during directory expansion: `.coverage`, `.DS_Store`, `.env`, `.netrc`, `.npmrc`, `.pypirc`, `.scratchpad.md`, `Thumbs.db`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and `id_rsa`; any file starting `.env.` except `.env.dist`, `.env.example`, `.env.sample`, and `.env.template`; any file ending `.db`, `.key`, `.p12`, `.pfx`, `.pyc`, `.pyd`, `.pyo`, `.pem`, `.sqlite`, `.sqlite3`, `.tsbuildinfo`, or `.tfstate`, plus the `-wal`, `-shm`, and `-journal` sidecars of `.db`, `.sqlite`, and `.sqlite3` files; and any file whose name contains `.tfstate.`.

When a whole-repo `.` archive exceeds the upload ceiling after default exclusions, Oracle prunes the largest directories named `build`, `dist`, `out`, `coverage`, `htmlcov`, `tmp`, `temp`, or `.tmp` that are not under `src`, `source`, `sources`, or `lib`. Any other oversize selection fails without automatic pruning.

### What the defaults do not cover

Default exclusions match directory and file names during directory expansion; they do not inspect file contents or block explicitly named paths:

- An explicitly named input is archived as named: passing a file explicitly includes it even when its name matches a default exclusion, and passing an excluded directory explicitly (such as `.git`) archives its entire subtree. Pass a diff bundle file rather than `.git` when a request needs Git history.
- Archive inputs resolve against the project root, not the working directory. Walking up from the working directory, Oracle takes the nearest directory that holds the host's config directory (`.omp` on Oh My Pi, `.pi` on `pi`) or an `AGENTS.md` file, and stops at the Git root; with no such marker it takes the Git root. Running from a subdirectory can therefore archive sibling paths inside that root.
- The walk stops below the home directory, where the host keeps its own `.omp` or `.pi`: from a directory under it, neither the home directory, a directory above it, nor the filesystem root becomes the project root. Outside a Git repository and with no marker on the way, the project root is the working directory.
- A session started in the home directory, above it, or at the filesystem root keeps that directory as the project root, and `oracle_submit` refuses a whole-repo `.` archive of it with `archive_input_too_broad`. Name the paths to archive instead.
- Before a job is created, `oracle_submit` rejects non-existent inputs with `archive_input_missing`, paths lexically outside the project root with `archive_input_outside_project`, and explicit inputs whose `realpath` escapes the project root with `archive_input_symlink_escape`. Symlinks encountered inside an expanded directory are packed as symlink entries without following or re-checking their targets.
- Default exclusions do not catch every secret: credentials stored under custom file names or inline in source code are included unless you pass narrower `files` paths that omit them. Review [`extensions/oracle/lib/archive.ts`](../extensions/oracle/lib/archive.ts) and [`prompts/oracle.md`](../prompts/oracle.md) before running on private or regulated code.

## Provider credentials

Each sign-in transport (how a job reaches a signed-in provider session) enforces its own credential and browser-isolation boundary.

### Isolated seed profile (default)

The isolated seed profile copies only allowlisted provider cookies into a separate browser directory and runs each job in a disposable clone:

- `/oracle-auth`, the sign-in command, snapshots the local Chromium `Cookies` database and its `Cookies-wal` and `Cookies-shm` sidecars into a `0700` temporary directory under the system temporary root, opens SQLite read-only, and deletes that snapshot immediately afterward. It never launches or mutates your real browser profile.
- Cookie decryption reads the browser's Safe Storage secret from the OS keyring (see [Cookie sources in Operations](OPERATIONS.md#cookie-sources)): macOS Keychain via `security find-generic-password` when `auth.chromiumKeychain` is set or via the `@steipete/sweet-cookie` cookie reader, `secret-tool` or `kwallet-query` and `dbus-send` or a one-run `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` override on Linux, and `@steipete/sweet-cookie`'s Chrome backend on Windows.
- `/oracle-auth` allowlists cookies before seeding: only recognized session, account, and Cloudflare challenge cookies on `chatgpt.com`, `chat.openai.com`, `openai.com`, `auth.openai.com`, `sentinel.openai.com`, `atlas.openai.com`, `ws.chatgpt.com`, and `browser.chatUrl` (restricted to `https://chatgpt.com` or `https://chat.openai.com`), or `grok.com`, `x.ai`, and `x.com` for Grok, are imported; foreign-domain, non-auth, analytics, and login-CSRF cookies are dropped.
- Imported cookies are written to the auth seed profile, the isolated browser profile `/oracle-auth` fills, at `browser.authSeedProfileDir` (or `<authSeedProfileDir>-grok` for Grok). That path must be absolute and outside real browser user-data directories and cookie sources, with its parent directory created at mode `0700` and a `0600` `.oracle-seed-generation` marker verified before any job starts.
- Each job copies the seed into a per-job runtime profile under `browser.runtimeProfilesDir`, whose parent directory uses mode `0700` while profile contents follow Chrome and process umask, and removes that copy during teardown once Chrome closes; runtime and conversation leases prevent sharing a runtime profile or provider thread (see [Isolated seed profile in Architecture](ARCHITECTURE.md#isolated-seed-profile)).
- Per-job Chrome starts with `--remote-debugging-port=0` (bound to loopback by Chrome default) and `--remote-allow-origins=*`, and `browser.args` cannot override `--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, or `--remote-allow-origins`. Any local process or local web page that discovers the ephemeral loopback DevTools port while a job runs can connect to that runtime profile without an `Origin` check.
- Every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable (such as `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` or `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`) is scrubbed from subprocess environments before browser, helper, or archive processes start.
- Seed and runtime profiles hold live provider sessions. Keep `browser.authSeedProfileDir` and `browser.runtimeProfilesDir` on an encrypted disk and do not copy them between machines.

### Existing-Chrome relay (opt-in, ChatGPT only)

The existing-Chrome relay drives one tab inside a signed-in Chrome you already run without copying cookies:

- No cookies are copied, and `/oracle-auth` refuses cookie import when `browser.chatGptRelayEndpoint` is configured.
- `browser.chatGptRelayEndpoint` is accepted only in the user-wide agent-level `oracle.json` and must be a loopback `http://` origin (`127.0.0.1`, `localhost`, or `[::1]`) without credentials, path, query, or fragment.
- Each job creates one job-owned pinned tab, pins every command to that tab's target id, fails closed on a missing or mismatched target instead of touching another tab, and closes only its own tab or releases the window's last tab to `about:blank` (see [Existing-Chrome relay transport in Architecture](ARCHITECTURE.md#existing-chrome-relay-transport)).
- The relay drives your live browser session: ChatGPT attributes every action to your signed-in account, and any local process that reaches `browser.chatGptRelayEndpoint` can control that Chrome. The extension adds no endpoint authentication; keep the relay bound to loopback.

### Managed browser (opt-in, ChatGPT only)

The managed browser runs ChatGPT in a dedicated Chrome profile without copying cookies from your personal browser:

- No cookies are copied; jobs drive one job-owned pinned tab each in a Chrome serving `browser.chatGptManagedProfileDir`, and `/oracle-auth` opens ChatGPT sign-in in that profile.
- `browser.chatGptManagedProfileDir` is agent-level only, must lie outside real browser user-data roots and cookie sources, and must stay separate from the ChatGPT and Grok auth seed profiles and `browser.runtimeProfilesDir`.
- Managed Chrome binds DevTools to loopback on an ephemeral port (`--remote-debugging-address=127.0.0.1` and `--remote-debugging-port=0`) without `--remote-allow-origins=*`, and blocks the same `browser.args` profile and DevTools overrides as isolated mode; any local process that reaches that port while Chrome runs can drive that browser.
- Oracle attaches to a running Chrome only when its live `/json/version` `webSocketDebuggerUrl`, saved as the browser identity `browserUrl`, matches the `DevToolsActivePort` record inside `browser.chatGptManagedProfileDir`, so a stale port file never binds the profile to another browser on a reused port.
- Before every browser command on a managed tab, the worker checks that the same browser identity (`browserUrl`) answers at the endpoint and stops with `managed_browser_changed` if another browser took the port. A command already past that check when the browser changes can reach `agent-browser`, whose reconnect can open a blank tab in the replacement browser before the next check halts the job.
- Oracle quits only a Chrome process spawned by its detached keeper process `managed-browser.mjs` and never quits a Chrome it found running (see [Managed browser transport in Architecture](ARCHITECTURE.md#managed-browser-transport)).

## Host trust boundary

Repository files cannot redirect browser paths or credentials, and untrusted repositories cannot load project overrides:

- Project config (the repository-scoped `oracle.json`) may set only `defaults`, `worker`, `poller`, `artifacts`, and `cleanup`. Any other top-level key fails config loading with `Invalid oracle project config: <key> cannot be overridden at the project level`, keeping `browser` and `auth` settings agent-level only.
- Every command and tool asks the host whether the project is trusted (`ctx.isProjectTrusted?.() ?? true`): a host omitting `isProjectTrusted` counts as trusted, and an untrusted project set via `--no-approve` or a saved untrusted decision has its project config skipped whole. Standalone loads without a session context honor `--approve` or `-a` and `--no-approve` or `-na`, then `pi`'s trust store, and skip the project file when no trust store exists.
- All projects for an OS user share `PI_ORACLE_JOBS_DIR`, while `oracle_read`, `/oracle-read`, and `/oracle-status` refuse to return another project's job unless its owning `projectId` is passed explicitly.
- Oracle refuses to submit or poll without a persisted host session (`--no-session`). A completion wake-up, the best-effort message sent when a job finishes, goes to the session that submitted the job while that session is live. Once that session has no live poller, another saved session in the same project can deliver it; a session in another project never does.

## Local data

Job files, auth diagnostics, and coordination locks are stored on local disk under owner-only directory modes and ownership checks:

- Each job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` and its `artifacts/` and `logs/` subdirectories use mode `0700` (see [the job directory layout](ARCHITECTURE.md#job-layout-under-the-configured-jobs-dir)). Sensitive files include `job.json`, `prompt.md`, the archive, `response.md`, `response.capture.json`, `response.raw.txt`, `response.raw.html`, `response.block-<n>.txt`, `.previous` backups, `artifacts.json`, `artifacts/`, and `logs/`.
- `job.json`, response captures, `artifacts.json`, downloaded artifacts, `.previous` recollection backups, and text failure dumps (`<reason>.url.txt`, `<reason>.snapshot.txt`, `<reason>.body.txt`, `<reason>.signals.txt`) are written to `0600` temporary files and renamed atomically into place.
- `prompt.md` is written directly with mode `0600`, `logs/worker.log` is appended with mode `0600`, `<reason>.png` failure screenshots are written by `agent-browser screenshot` inside `0700` `logs/`, and context archives are built first directly in the system temporary directory (`0600` for `.tar.gz`; process umask via `zstd -o` for `.tar.zst`) before rename into the `0700` job directory.
- Before saving `response.md`, `response.raw.txt`, `response.raw.html`, `response.block-<n>.txt`, `response.capture.json`, and `artifacts.json`, response capture strips active DOM elements (`script`, `style`, `form`, `input`, `textarea`) and transient HTML attributes, and replaces HTTP or HTTPS URLs carrying signed query parameters such as `sig`, `signature`, `token`, `access_token`, `auth`, `policy`, `expires`, `x-amz-*`, `x-goog-*`, `se`, `sp`, or `sv` with `[transport-url-redacted]`.
- Tool results returned to the host agent include status, `projectId`, `sessionId` (which is the session file path), `chatUrl`, `response.md` previews and paths, and error messages. They omit the saved `config` snapshot and the browser runtime paths from `job.json`.
- Each `/oracle-auth` run creates a `0700` `pi-oracle-auth-*` directory under the system temporary directory (`$TMPDIR` on macOS, usually `/tmp` on Linux) and prints its path; it holds `0600` `oracle-auth.log`, `oracle-auth.url.txt`, `oracle-auth.snapshot.txt`, and `oracle-auth.body.txt`, plus `oracle-auth.png` when captured. `/oracle-clean <job-id|all>` and retention remove terminal job directories only; delete `pi-oracle-auth-*` bundles manually when finished.
- Job reads, listings, and queued-job starts accept only alphanumeric, hyphen, and underscore job ids, paths directly under the configured jobs root, non-symlink job directories and `job.json` files, and a saved `job.json` `id` matching the directory id. On POSIX, both the directory and `job.json` must belong to the current `uid` and have no group or world write bits; Windows skips `uid` and mode checks while keeping the id, parent-directory, and symlink checks.
- Lock and lease state is stored under `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}` (`0700` directories, `0600` metadata and `managed-browser.log`). A symlinked state root (or, on POSIX, one owned by another `uid`) is refused with `Oracle state directory <dir> is <a symlink | owned by uid N>; refusing to use it. Point PI_ORACLE_STATE_DIR at a private directory you own.`
- The default jobs root `/tmp` is shared across local accounts. On multi-user hosts, set private per-user directories for both `PI_ORACLE_JOBS_DIR` and `PI_ORACLE_STATE_DIR` instead of sharing `/tmp` and `/tmp/pi-oracle-state`, and do not repair or delete another user's directory (see [Oracle refuses the state directory](OPERATIONS.md#oracle-refuses-the-state-directory)).
- `agent-browser` session `.target` and `.config` sidecar files hold conversation URLs and session settings. Teardown deletes a session's sidecars in the resolved driver socket directory, honoring `AGENT_BROWSER_NAMESPACE`, only after `agent-browser session list` confirms the session is absent; a failed close or session listing leaves sidecars on disk for manual cleanup (see [Old agent-browser session sidecars](OPERATIONS.md#old-agent-browser-session-sidecars)).

## Release integrity

Published npm packages are built and attested from tagged commits on `main` without long-lived registry tokens:

- npm releases are published by [`.github/workflows/release.yml`](../.github/workflows/release.yml) through npm trusted publishing: no long-lived npm token exists, and the job that can publish runs no repository or dependency code. Versions published this way carry an npm provenance attestation naming the commit and workflow run, shown on the package page and checked by `npm audit signatures`. `0.4.6` and earlier were published from the maintainer's workstation and carry none.

## Out of scope

The following threats sit outside OMP Oracle's local boundary:

- Hostile processes running under your own OS user, and unauthorized local access to loopback DevTools or relay ports. File ownership checks stop another `uid`'s planted jobs from being read or promoted, and are not a process sandbox or port authenticator. On multi-user machines, keep profiles and state private and restrict access to loopback browser-control ports; do not run on a shared shell host without that isolation.
- Provider-side retention and training handling of uploaded archives and prompts, which are governed by your ChatGPT or Grok account and its data settings rather than this extension.
- Provider web-UI drift: layout changes can fail a job, and cannot cause `oracle_submit` to upload paths outside the selected archive inputs.

To report a suspected vulnerability privately, see the [security policy](../SECURITY.md).
