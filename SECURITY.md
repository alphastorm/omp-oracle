# Security policy

Use this policy to report a suspected vulnerability in OMP Oracle privately.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Submit a private report through [GitHub private vulnerability reporting](https://github.com/alphastorm/omp-oracle/security/advisories/new).

Include in your report:

- `omp-oracle` version or commit
- Host (Oh My Pi or `pi`) and its version
- Operating system and browser version
- Sign-in transport (isolated seed profile, existing-Chrome relay, or managed browser)
- Minimal reproduction steps and redacted logs (`worker.log` or `oracle-auth.log`, with conversation URLs, local paths, and account identifiers removed)

Never attach secrets or private job files to a report:

- Cookies, session tokens, or browser profile directories (`oracle-auth-seed-profile`, runtime profiles, or managed Chrome profiles)
- Unredacted `job.json` fields or private provider conversation contents
- Job directory content files (`prompt.md`, `context-<job-id>.tar.zst`, `context-<job-id>.tar.gz`, `response.md`, `response.capture.json`, `response.raw.txt`, `response.raw.html`, `response.block-<n>.txt`, `artifacts.json`, files under `artifacts/`, and diagnostic captures under `logs/` or `pi-oracle-auth-*`)
- `agent-browser` `.target` and `.config` sidecar files, which hold conversation URLs and session settings

## Scope

See the [Security model](docs/SECURITY.md) for what leaves your machine, default archive exclusions, credential handling per sign-in transport, local trust boundaries, and out-of-scope threats. Provider-side handling of uploaded archives and prompts is governed by your ChatGPT or Grok account, not by this extension.

`pi-oracle` on npm is the upstream package; report vulnerabilities in upstream code to [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle) unless they are specific to this fork (see [Upstream](docs/UPSTREAM.md) for fork-owned changes).

## Supported versions

The latest commit on `main` and the most recent published `omp-oracle` release receive security fixes.
