# OMP Oracle security model

For operators and reviewers evaluating what `omp-oracle` sends off the machine, how it handles
provider credentials, and which local trust boundaries it enforces in Oh My Pi (OMP) and `pi`.
For transport and configuration setup, see [Operations](OPERATIONS.md); for supported hosts,
platforms, and limits, see [Compatibility](COMPATIBILITY.md) and [Architecture](ARCHITECTURE.md).
To report a suspected vulnerability privately, follow the [security policy](../SECURITY.md).

## What leaves the machine

For each job, `oracle_submit` sends the prompt and one project archive to the selected provider
(`chatgpt.com` or `grok.com`) through that provider's web app in the browser under your own
account. `omp-oracle` adds no telemetry, analytics, or hosted control plane; the browser still
makes the ordinary web requests required to load and run the provider's web app.

The archive is built locally from project-relative paths you or the agent pass to `oracle_submit`:

- Default exclusions apply when expanding a whole-repo `.` or a directory input: VCS and tool
  state anywhere in the tree (`.git`, `.hg`, `.svn`, `.pi`, `.oracle-context`, `.cursor`,
  `.artifacts`, `.crabbox`), dependency, cache, and build directories (`node_modules`, `target`,
  `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `.terraform`, `.gradle`, `.yarn/cache`, and
  siblings), and `secrets/` or `.secrets/`.
- Files excluded by default during directory expansion: `.env` and `.env.*` (except `.env.dist`,
  `.env.example`, `.env.sample`, `.env.template`), `.netrc`, `.npmrc`, `.pypirc`, `.coverage`,
  `.DS_Store`, `Thumbs.db`, `.scratchpad.md`, SSH private key names (`id_dsa`, `id_ecdsa`,
  `id_ed25519`, `id_rsa`), `.tfstate.*`, and key, bytecode, or database suffixes (`.db`, `.key`,
  `.p12`, `.pfx`, `.pem`, `.pyc`, `.pyd`, `.pyo`, `.sqlite`, `.sqlite3`, `.tsbuildinfo`,
  `.tfstate`).
- Root-level generated output (`coverage`, `htmlcov`, `tmp`, `temp`, `.tmp`, `dist`, `build`,
  `out`) is excluded by default when expanding `.`; when a whole-repo `.` archive still exceeds
  the upload ceiling, the largest generated-output directories outside source roots (`src/`,
  `source/`, `sources/`, `lib/`) are pruned automatically.
- An input named explicitly is archived as named: an explicitly passed file is included even when
  its name matches a default exclusion, and an explicitly passed directory that default exclusions
  would skip (for example `.git`) is archived with its whole subtree. Review requests that need Git
  history should pass a diff bundle file rather than naming `.git`.
- Every archive input must resolve inside the project root without symlink escapes. Any path that
  resolves outside the project is rejected before a job is created
  (`archive_input_symlink_escape`). Symlinks inside the tree are archived as symlinks, never
  followed.
- Archives are capped at 250 MiB for ChatGPT (`.tar.zst`) and 200 MiB for Grok (`.tar.gz`).
  Oversize archives are pruned or rejected locally; nothing is partially uploaded.

Default exclusions are a floor, not a guarantee. Review
[`extensions/oracle/lib/archive.ts`](../extensions/oracle/lib/archive.ts) and
[`prompts/oracle.md`](../prompts/oracle.md) before running on private or regulated code, and pass
narrower paths when the whole repository should not leave the machine.

## Provider credentials

### Isolated seed profile (default)

- `/oracle-auth` reads provider cookies from the local browser cookie store in read-only mode. It
  never launches or mutates your real browser profile; on macOS the Chromium `Cookies` database
  and its `Cookies-wal` / `Cookies-shm` sidecars are snapshotted into a private temp directory
  before reading.
- Imported cookies are written to an isolated seed profile at `browser.authSeedProfileDir` (or
  `<authSeedProfileDir>-grok` for Grok), which must be an absolute path outside known real browser
  user-data trees. Staged profiles swap in atomically, keep the previous seed for rollback, and
  record a `.oracle-seed-generation` marker verified before any job is admitted.
- Each job clones the seed into a private runtime profile under `browser.runtimeProfilesDir` and
  deletes the clone in `finally`. Runtime and conversation leases prevent two jobs from sharing a
  runtime profile or a provider thread.
- Safe-storage password overrides (every `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` variable, such as
  `SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD` or `SWEET_COOKIE_CHROMIUM_SAFE_STORAGE_PASSWORD`) are
  scrubbed from the environment before browser, helper, or archive subprocesses start.
- Seed and runtime profiles hold live provider sessions. Treat `browser.authSeedProfileDir` and
  `browser.runtimeProfilesDir` as credential stores: keep them on an encrypted disk and do not
  copy them between machines.

### Existing-Chrome relay (opt-in, ChatGPT only)

- No cookies are copied. Each job drives one tab in your signed-in Chrome through the configured
  CDP relay endpoint, and `/oracle-auth` refuses cookie import in relay mode.
- `browser.chatGptRelayEndpoint` can be set only in agent-level config and must be a loopback
  `http://` origin (`127.0.0.1`, `localhost`, or `[::1]`) without credentials.
- Each job owns one tab, pins every browser command to its target id, and fails closed on a
  missing or mismatched target instead of touching another tab. Cleanup verifies ownership and
  closes only the job's tab (or releases the window's last tab to `about:blank`).
- The relay controls your live browser session: the provider attributes every action to your
  account, and any local process that can reach the relay endpoint can drive that Chrome. The
  extension adds no authentication to the endpoint; keep it on loopback.

### Managed browser (opt-in, ChatGPT only)

- No cookies are copied. Jobs drive one owned tab each in a Chrome running on the dedicated
  profile at `browser.chatGptManagedProfileDir`, and `/oracle-auth` opens ChatGPT sign-in there.
  The directory is agent-level only, must not be a real browser profile root, and must stay
  separate from the ChatGPT and Grok seed profiles and `browser.runtimeProfilesDir`.
- Oracle attaches to a running Chrome only when the endpoint's live `/json/version` browser id
  matches the `DevToolsActivePort` record Chrome wrote inside that profile, so a stale file never
  binds the profile or its account to another browser on a reused port.
- DevTools listens on loopback only, on an ephemeral port (`--remote-debugging-port=0`), without
  wildcard `--remote-allow-origins`; any local process that reaches that port while Chrome runs
  can drive that browser.
- Oracle quits only a Chrome process its keeper spawned, never one it found running. Signalling
  the keeper quits its Chrome cleanly; a keeper that crashes or is killed outright leaves Chrome
  running rather than guessing at a PID.
- Before every browser command on a managed job's tab, the worker checks that the same browser id
  still answers at the endpoint, stopping with `managed_browser_changed` if another browser took
  the port instead of sending the prompt or archive there. A command already past that check when
  the browser changes can still reach `agent-browser`, whose reconnect can open a blank tab in the
  other browser before the next check halts the job.

## Host trust boundary

- Project-level `oracle.json` may override only `defaults`, `worker`, `poller`, `artifacts`, and
  `cleanup`; any other key is rejected. Browser paths, cookie sources, keychain items, the relay
  endpoint, and the managed browser profile are agent-level only, so a repository cannot point the
  extension at a different browser or credential source.
- Project config is ignored when the host reports the project untrusted (`--no-approve` or a
  saved do-not-trust decision). On OMP hosts without Pi's trust exports, project overrides require
  an explicit host trust decision or approval flag.
- Oracle refuses to run without a persisted host session (`--no-session`), so completion wake-ups
  cannot be routed to a different session than the one that submitted the job.

## Local data

- Job state lives under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with `0700` directories
  and `0600` files, written atomically: `job.json`, `prompt.md`, the archive (deleted once the
  upload succeeds), `response.md`, `response.capture.json`, `artifacts.json` and `artifacts/`
  with size and SHA-256 records, and `logs/worker.log`.
- Tool results returned to the agent carry redacted job details rather than raw job state.
- Auth diagnostics (`oracle-auth.log`, URL, snapshot, body, and screenshot) are written to a
  `0700` per-run directory under `/tmp/pi-oracle-auth-*/`; lock and lease state lives under
  `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}`. Treat job directories and auth diagnostics as
  sensitive local files; `/oracle-clean <job-id|all>` and age-based retention remove terminal job
  directories.

## Release integrity

- npm releases are published by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
  through npm trusted publishing: no long-lived npm token exists, and the job that can publish runs
  no repository or dependency code. Versions published this way carry an npm provenance
  attestation naming the commit and workflow run, shown on the package page and checked by
  `npm audit signatures`. `0.4.6` and earlier were published from the maintainer's workstation and
  carry none.

## Out of scope

- Untrusted local accounts on the same machine. Jobs, state, profiles, and loopback DevTools or
  relay ports rely on OS user isolation and file permissions. Do not run on a shared shell host.
- Provider-side handling of uploaded archives and prompts is governed by your ChatGPT or Grok
  account and its data settings, not by this extension.
- Provider UI drift can fail a job; it cannot cause `oracle_submit` to upload paths outside the
  selected archive inputs.

To report a suspected vulnerability privately, see the [security policy](../SECURITY.md).
