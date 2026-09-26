# omp-oracle Project Instructions

This file contains project-specific guidance for this repository.

## Project map
- `extensions/oracle/index.ts` registers the extension and the OMP programmatic bridge.
- `extensions/oracle/lib/` contains the agent-facing tools, slash commands, config, queue/job state, runtime/profile coordination, and poller logic.
- `extensions/oracle/worker/` contains the detached browser worker, auth bootstrap, relay driver, browser UI helpers, cookie policy, and artifact heuristics.
- `extensions/oracle/shared/` contains cross-process lifecycle, observability, process, and state-coordination helpers used by both extension and worker code.
- `prompts/` contains the `/oracle` and `/oracle-followup` prompt templates.
- `scripts/oracle-sanity.ts` is the main regression/source-contract sanity harness; it also pins documentation contracts in `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, and `docs/TEST_PLAN.md`. `npm run verify:oracle` is the local full gate.
- `README.md` is the user-facing entry point. `docs/ARCHITECTURE.md` is the durable design source of truth; `docs/SECURITY.md`, `docs/COMPATIBILITY.md`, `docs/OPERATIONS.md`, `docs/TEST_PLAN.md`, `docs/PLATFORM_SMOKE.md`, `docs/RELEASE.md`, and `docs/UPSTREAM.md` follow the layout of the other `omp-*` repositories.
- `site/` is the GitHub Pages source; `.github/workflows/` holds the CI local gate and the Pages deploy, which stages the site's mark, favicon, and social preview from `assets/` so `site/` never carries copies.
- `assets/` holds the canonical brand mark, favicon, and the editable banner and social-preview HTML sources with their PNG renders (`npm run render:assets`). `docs/BRANDING.md` is the brand source of truth.

## Naming
- The npm package is `omp-oracle`; `pi-oracle` on npm is the upstream package and must not be presented as an install path for this fork.
- Refer to the maintainer org by its GitHub handle, `alphastorm`, never a stylized form.
- Runtime identifiers keep their upstream names (`PI_ORACLE_*` environment variables, `/tmp/pi-oracle-state`, `/tmp/pi-oracle-auth-*`, the `omp.pi-oracle.programmatic.v1` symbol); do not rename them for cosmetics.

## Single-operator ownership
- Treat this repository as single-operator: no human or external agent is working here except the current agent.
- Assume every lingering change, background process, temp file, queue entry, job directory, or other artifact was created by a prior version of you or by one of your delegated runs.
- You own reconciliation and cleanup for that state. Do not attribute unexplained repo state to another person.

## Extension testing feedback
- Pre-commit requirement for any code changes: always test with isolated agent sessions that load this local version of the extension (`docs/TEST_PLAN.md`).
- Use those isolated sessions to validate the changed behavior works as expected end-to-end, not just through local unit/sanity coverage.
- For these isolated-session validation runs, use the `instant` or `thinking_light` preset.
- During those tests, feel free to ask the agents you are exercising for suggestions and feedback about the tool.
- Ask specifically about friction points such as clunky behavior, uninformative output, workflows that feel slower with no clear gain, or anything else that seems off during real use.

## Temporary working files
- `progress.md` and `review.md` are temporary working artifacts.
- If `progress.md` exists, read it at the start of a continuation to recover current branch/task state; keep it concise and current during active work.
- Do not put changelog/history in `AGENTS.md`; use `progress.md` for transient handoff state and delete it once the work is committed or no longer useful.
- Ignore temporary artifacts locally or delete them once they have been consumed.
- Do not leave temporary working files around as untracked repo noise after they are no longer useful.
