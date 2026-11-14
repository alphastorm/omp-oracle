# Contributing

Follow this guide to take a code or documentation change in OMP Oracle from a local clone to an accepted pull request. Behavior changes require verification output from the local gate and the matching check below.

## Before you start

You need Node.js `22.19.0` or newer (`engines.node` in `package.json`; hosted CI runs the gate on Node 24), and `tar` and `zstd` on `PATH`.

1. Check open issues and pull requests, and keep your change scoped to one problem.
2. Read [Architecture](docs/ARCHITECTURE.md) and [Upstream](docs/UPSTREAM.md) to see whether the change belongs in this Oh My Pi (OMP) fork or in upstream [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle). Fixes that are not specific to Oh My Pi may belong upstream.
3. Install dependencies from the lockfile:

   ```bash
   npm ci
   ```

4. Run the local gate before and after your change. It passes when the command exits `0`:

   ```bash
   npm run verify:oracle
   ```

## What a change needs

Run the commands for every surface your pull request touches and include the results in the pull request description:

| Change type | Commands | Guide |
| --- | --- | --- |
| Documentation | `npm run verify:oracle` | [Local gate](docs/TEST_PLAN.md#local-gate) |
| Runtime or extension code | `npm run verify:oracle`, `pi --approve --no-extensions -e ./extensions/oracle/index.ts` | [Isolated `pi` session smoke](docs/TEST_PLAN.md#isolated-pi-session-smoke) |
| Platform-sensitive code, package metadata, or Crabbox | `npm run verify:oracle`, `npm run smoke:platform:doctor`, `node scripts/platform-smoke.mjs run --target <target> --suite <suite>` | [Platform smoke](docs/PLATFORM_SMOKE.md) |
| Model selection or ChatGPT UI | `npm run verify:oracle`, `npm run release:proof:chatgpt-presets:run`, `npm run release:proof:chatgpt-presets` | [ChatGPT preset proof](docs/RELEASE.md#chatgpt-preset-proof) |
| Brand artwork (`assets/*.html`, `assets/brand.css`) | `npm run render:assets`, `npm run render:assets -- --check`, `npm run verify:oracle` | [Branding](docs/BRANDING.md) |

[Which check to run](docs/TEST_PLAN.md#which-check-to-run) lists every check, and [Local gate](docs/TEST_PLAN.md#local-gate) lists what `npm run verify:oracle` (`npm test` is an alias) runs. Checks beyond the local gate need more tools: `pi` or `omp`, `agent-browser`, Chrome, Crabbox, or a signed-in ChatGPT session. Each linked guide says which.

Typechecking compiles three projects directly: `tsconfig.extension.json`, `tsconfig.worker-helpers.json`, and `tsconfig.worker-runtime.json`. The root `tsconfig.json` sets `"files": []` and references those three files so editors and language servers check each file with its own project's compiler options.

## Documentation changes

Documentation follows code. When you change a command, tool, config key, limit, or preset, update the document that owns it in the same pull request:

- `README.md`: the preset table and the archive ceilings.
- [Operations](docs/OPERATIONS.md): commands, tools, config keys, environment variables, and error codes.
- [Compatibility](docs/COMPATIBILITY.md): support status and the current release.
- [Security model](docs/SECURITY.md): archive exclusions and trust boundaries.
- [Architecture](docs/ARCHITECTURE.md): the job lifecycle and state on disk.

Two checks in the local gate cover documentation:

- `npm run test:docs` (`scripts/docs-links.test.mjs`) fails when a relative link, heading fragment, or link into this repository does not resolve, or when a page names a maintainer host, a real home directory, or a process id. When you rename a section, keep the old link working with `<a id="old-slug"></a>` directly above the heading.
- `scripts/oracle-sanity.ts` fails unless `README.md` lists every preset id (in backticks) and every preset label from `ORACLE_SUBMIT_PRESETS` in `extensions/oracle/lib/config.ts`.

Dated records:

- Add an entry under `## Unreleased` in the [Changelog](CHANGELOG.md) for every change.
- Never edit a published entry in the [release ledger](docs/RELEASE.md#evidence-ledger).

## Repository layout

| Path | Purpose |
| --- | --- |
| `extensions/oracle/index.ts` | Extension entrypoint, `/oracle` and `/oracle-followup` dispatch, startup poller, and `omp.pi-oracle.programmatic.v1` bridge |
| `extensions/oracle/lib/` | Commands, `/oracle-run`, tools, config, project trust, archive packing and pruning, provider capabilities, jobs, queue, runtime, poller, and locks |
| `extensions/oracle/worker/` | Detached job worker, auth bootstrap, cookie-source helpers, managed browser, page-state classifiers, response capture, and artifact heuristics |
| `extensions/oracle/shared/` | Relay CDP client and helpers, managed-browser helpers, process and sidecar teardown, state paths, locks, `/oracle-run` shapes, and observability formatting |
| `prompts/` | Hidden dispatch workflows for `/oracle` (`prompts/oracle.md`) and `/oracle-followup` (`prompts/oracle-followup.md`) |
| `scripts/` | Syntax, unit, native, link, and site checks; `scripts/oracle-sanity*` suites; capture and preset proofs; real-session and `scripts/platform-smoke*` runners; asset renderer |
| `platform-smoke.config.mjs` | Crabbox targets, suites, Node validation major, and Ubuntu image config (`scripts/platform-smoke/` holds the runner modules) |
| `tsconfig.json` | Root project-reference file referencing `tsconfig.extension.json`, `tsconfig.worker-helpers.json`, and `tsconfig.worker-runtime.json` |
| `site/` | Public website source, `llms.txt`, and self-hosted fonts (`licenses/fonts/` holds font licenses) |
| `assets/` | Brand mark, favicon, and banner and social-preview HTML sources and PNG renders ([Branding](docs/BRANDING.md)) |
| `docs/` | [Documentation index](docs/README.md) and the operator, security, compatibility, architecture, testing, smoke, release, upstream, and branding guides |
| `.github/workflows/` | Hosted local-gate CI (`ci.yml`), tag-driven trusted npm publishing (`release.yml`), and GitHub Pages deployment (`pages.yml`) |

## Naming and identifiers

- The npm package is `omp-oracle` (display name **OMP Oracle**). `pi-oracle` on npm is the upstream package; never present it as an install path for this fork.
- Runtime identifiers keep their upstream names: `/oracle*` commands, `oracle_*` tools, `PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, the `pi-oracle-auth-*` directory under the system temporary directory (use the path `/oracle-auth` prints rather than assuming `/tmp`), and the `omp.pi-oracle.programmatic.v1` bridge symbol.
- Write the maintainer organization in lowercase as `alphastorm`.

<a id="commits"></a>
## Commits and pull requests

Write commit messages and pull request titles in [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format (`type(scope): description`, lowercase imperative). Pull requests merge by squash only, so the pull request title becomes the commit subject on `main`; include the verification commands you ran and their results in the pull request body.

## Releases

Before tagging a release, maintainers run `npm run release:check` locally across the local gate, the offline capture proof, the live ChatGPT preset proof, and the Crabbox platform matrix. Pushing a `vX.Y.Z` tag on `main` publishes the tarball to npm from GitHub Actions through OIDC trusted publishing; see [Release](docs/RELEASE.md) for the release sequence, [publishing](docs/RELEASE.md#publishing), and the [release ledger](docs/RELEASE.md#evidence-ledger).

## Security

Report suspected vulnerabilities privately per the [Security policy](SECURITY.md).
