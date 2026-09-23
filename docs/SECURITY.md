# OMP Oracle security model

What leaves your machine, what stays, and which boundaries the code enforces. This is the trust
model for `omp-oracle`, not a promise about the providers on the other end.

Companion docs: [Architecture](ARCHITECTURE.md) · [Operations](OPERATIONS.md) ·
[Compatibility](COMPATIBILITY.md)

## What leaves the machine

Every `oracle_submit` uploads exactly two things to the selected provider's web app under your
own account: the prompt and one project archive. Nothing else is sent anywhere. There is no
telemetry, no hosted control plane, and no third-party service between the host and ChatGPT.com
or grok.com.

The archive is built locally from paths you or the agent select, relative to the project root:

- Default exclusions apply anywhere in the tree: VCS metadata (`.git`, `.hg`, `.svn`), host and
  tool state (`.pi`, `.oracle-context`, `.cursor`, `.artifacts`, `.crabbox`), dependency and build
  caches (`node_modules`, `target`, `.venv`, `__pycache__`, `.next`, `.turbo`, `.terraform`, and
  similar), and any `secrets/` or `.secrets/` directory.
- Files excluded by name or suffix: `.env` and `.env.*` (except `.env.dist`, `.env.example`,
  `.env.sample`, `.env.template`), `.netrc`, `.npmrc`, `.pypirc`, SSH private keys (`id_rsa`,
  `id_ed25519`, and siblings), and key/database material by suffix (`.key`, `.pem`, `.p12`,
  `.pfx`, `.db`, `.sqlite`, `.sqlite3`, `.tfstate`).
- Root-level generated output (`dist`, `build`, `out`, `coverage`, `tmp`, and siblings) is
  excluded; when a whole-repo archive is still over the ceiling, the largest generated-output
  directories outside source roots such as `src/` and `lib/` are pruned automatically.
- Every archive input must resolve inside the project root without symlink escapes. A path that
  resolves outside is rejected before any job is created (`archive_input_symlink_escape`).
  Symlinks inside the tree are archived as symlinks, never followed.
- Archives are capped at 250 MiB for ChatGPT and 200 MiB for Grok. Oversize archives are pruned
  or rejected locally; nothing is partially uploaded.
- The `.git` directory is never included. Review requests that need history ask the agent to add
  a diff bundle file explicitly.

The exclusion list is a floor, not a guarantee. Review
[`extensions/oracle/lib/archive.ts`](../extensions/oracle/lib/archive.ts) and the prompt in
[`prompts/oracle.md`](../prompts/oracle.md) before using the tool on private or regulated
material, and select narrower inputs when the whole repository should not leave the machine.

## Provider credentials

### Isolated seed profile (default)

- `/oracle-auth` reads provider cookies from the local browser cookie store in read-only mode. It
  never launches or mutates your real browser profile; on macOS the Chromium `Cookies` DB and its
  sidecars are snapshotted into a private temp directory before reading.
- Imported cookies are written to an isolated seed profile at `browser.authSeedProfileDir`, which
  must be an absolute path outside the real Chrome user-data tree. The staged profile is swapped
  in atomically and the previous seed is kept as rollback.
- Each job clones the seed into a private runtime profile and deletes it in `finally`. Runtime
  and conversation leases prevent two jobs from sharing a runtime or a provider thread.
- Safe-storage password overrides (`SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD`) are scrubbed from the
  environment before browser or helper subprocesses start, and archive subprocesses never
  inherit browser safe-storage secrets.
- Seed and runtime profiles hold live provider sessions. Treat `browser.authSeedProfileDir` as a
  credential store: keep it on an encrypted disk and do not copy it between machines.

### Existing-Chrome relay (opt-in, ChatGPT only)

- No cookies are copied. The job drives one tab in your signed-in Chrome through the configured
  CDP relay endpoint, and `oracle_auth` refuses cookie import in relay mode.
- The endpoint can be set only in agent-level config, never by a project.
- Each job owns exactly one tab, pins every command to it, and fails closed on a missing or
  mismatched target instead of touching another tab. Cleanup closes only the owned tab and
  verifies its removal.
- The relay is your real browser session: the provider attributes every action to your account,
  and anything that can reach the relay endpoint can drive Chrome. The extension adds no
  authentication to that endpoint; keep it loopback-only.

### Managed browser (opt-in, ChatGPT only)

- No cookies are copied. Jobs drive one owned tab each in a Chrome running on the configured
  Oracle-dedicated profile, and `oracle_auth` opens ChatGPT sign-in there instead of importing
  cookies. The profile directory is agent-level only, must not be a real browser profile root,
  and must stay separate from the seed and runtime profile directories.
- Oracle attaches to a running Chrome only when the endpoint's live browser id matches the one
  Chrome recorded inside that profile, so a stale record never binds the profile, and its account,
  to another browser listening on a reused port.
- DevTools listens on loopback only, on an ephemeral port, and only while that Chrome runs;
  anything local that reaches the port can drive the browser. Oracle adds no wildcard
  `--remote-allow-origins`.
- Oracle quits only a Chrome its keeper spawned, by signalling that child process, never one it
  found running; a keeper that dies leaves its browser up rather than guessing at a PID.

## Host trust boundary

- Project-level `oracle.json` may override only `defaults`, `worker`, `poller`, `artifacts`, and
  `cleanup`; any other key is rejected. Browser paths, cookie sources, keychain items, the relay
  endpoint, and the managed browser profile are agent-level only, so a cloned repository cannot
  point the extension at a different browser or credential source.
- Project config is ignored when the host reports the project untrusted (`--no-approve` or a
  saved distrust decision). On OMP hosts without Pi's trust exports, project overrides require an
  explicit host trust decision or approval flag.
- Oracle refuses to run without a persisted session identity, so completion wake-ups cannot be
  delivered to a different session than the one that submitted the job.

## Local data

- Job state lives under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` with `0700` directories
  and `0600` files, written atomically: the prompt, the archive (deleted once the upload
  succeeds), the plain-text response, downloaded artifacts with a size and SHA-256 manifest, and
  the worker log with failure diagnostics.
- Tool results returned to the agent carry redacted job details, not raw job state.
- Auth diagnostics are written to a `0700` per-run directory under `/tmp/pi-oracle-auth-*`; lock
  and lease state lives under `${PI_ORACLE_STATE_DIR:-/tmp/pi-oracle-state}`. `/oracle-clean` and
  age-based retention remove terminal job directories.

## Out of scope

- Untrusted local accounts. Jobs, state, and profile directories are protected by file
  permissions only. Do not run on a shared shell host.
- Provider-side handling of uploaded archives and prompts is governed by your ChatGPT or Grok
  account and its data settings, not by this extension.
- Provider UI drift can fail a job; it cannot cause an upload of paths you did not select.

## Reporting

Do not file suspected vulnerabilities as public issues. Use GitHub private vulnerability
reporting: [Report a vulnerability](https://github.com/alphastorm/omp-oracle/security/advisories/new).
Include the affected version, the transport (isolated profile or relay), and reproduction steps
with secrets redacted. The repository policy is [`SECURITY.md`](../SECURITY.md).
