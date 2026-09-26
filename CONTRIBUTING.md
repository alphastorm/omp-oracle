# Contributing

`omp-oracle` is developed in public. Issues and pull requests are welcome; the bar is that
behavior claims are proven, not described.

## Before you start

- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and
  [`docs/UPSTREAM.md`](docs/UPSTREAM.md) for what is fork-specific. Fixes that are not
  OMP-specific may belong upstream in [`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle).
- Run `npm ci` with Node 24, then `npm run verify:oracle`. It must be green before and after
  your change.

## What a change needs

1. **The local gate.** `npm run verify:oracle` runs syntax and bundle checks, helper unit tests,
   the site coherence test, both typechecks, the sanity harness, and `npm pack --dry-run`. The
   sanity harness also pins documentation contracts; if you change a command, tool, limit, or
   preset, update `README.md` and the relevant `docs/` page in the same change.
2. **An isolated-session smoke** for code changes, following
   [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md): load the local extension in an isolated session,
   exercise the changed path, and record what you saw. Use the `instant` or `thinking_light`
   preset.
3. **Focused platform runs** when the change touches archive behavior, process cleanup,
   runtime/browser profile handling, package metadata, or the Crabbox harness:
   [`docs/PLATFORM_SMOKE.md`](docs/PLATFORM_SMOKE.md).
4. **A changelog entry** under `Unreleased` in [`CHANGELOG.md`](CHANGELOG.md).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): description`, lowercase imperative.

## Naming and identifiers

- The npm package is `omp-oracle`. Runtime identifiers keep their upstream names
  (`/oracle*` commands, `oracle_*` tools, `PI_ORACLE_*` environment variables,
  `/tmp/pi-oracle-state`, the `omp.pi-oracle.programmatic.v1` bridge symbol); do not rename them.
- Refer to the maintainer org as `alphastorm`, matching the GitHub handle.

## Releases

Publishing runs `npm run release:check` through `prepublishOnly`: the local gate, fresh live
ChatGPT preset proof for every canonical preset, and the doctor-first Crabbox matrix. The
procedure and the evidence ledger are in [`docs/RELEASE.md`](docs/RELEASE.md).

## Security

Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md).
