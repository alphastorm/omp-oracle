# OMP Oracle compatibility

What `omp-oracle` runs on, what it talks to, and where the claim stops. Observed means it was
exercised and recorded; declared means package metadata allows it without a matching proof.

Companion docs: [Operations](OPERATIONS.md) · [Release](RELEASE.md) · [Test plan](TEST_PLAN.md)

## Hosts

| Host | Status | Evidence |
| --- | --- | --- |
| `pi` 0.80.9 | Validated baseline (upstream) | Upstream `pi-oracle` 0.7.19/0.7.20 release gates ran `npm run verify:oracle` and the Crabbox matrix against Pi 0.80.9; entries in the [release ledger](RELEASE.md#evidence-ledger) |
| `pi` newer than 0.80.9 | Declared, not validated | Runtime packages are optional wildcard peers, so npm does not block newer releases |
| `pi` older than 0.80.9 | Not blocked, outside the baseline | Not exercised by the current gate |
| Oh My Pi 18.2.6 | Observed loading (upstream build) and preflight | `omp plugin list` shows upstream `pi-oracle@0.7.20` loaded as an npm plugin and `oracle_preflight` reported ready with the relay transport reachable; `omp install --dry-run` resolves this checkout as `omp-oracle` and accepts the GitHub URL. No job has run through the fork's build on OMP, and no platform matrix or preset proof has been run there |
| Oh My Pi hosts without Pi's trust exports | Supported by design | `scripts/oracle-host-compat.test.mjs` links the config loader against a host API without `hasTrustRequiringProjectResources`/`ProjectTrustStore`; project overrides then require an explicit host trust decision |

A persisted session is required on every host. `--no-session` runs report oracle unavailable.

## Platforms and runtime

| Requirement | Value |
| --- | --- |
| Operating systems | macOS, Linux, Windows native (`package.json` `os`). The fork's Crabbox gate requires macOS and Ubuntu; Windows native is upstream-validated at `pi-oracle` 0.7.20 and not re-qualified by the fork, because the fork owns no Windows lane |
| Node.js | 22.19.0 or newer to install and run (`engines`); the platform smoke and release validation expect Node 24+ (`platform-smoke.config.mjs`) |
| Browser | Google Chrome, Chromium, or another Chromium-family browser |
| Local tools | `agent-browser` (0.35.0 or newer for relay mode) and `tar`; `zstd` for ChatGPT `.tar.zst` archives; `cp` on PATH or `PI_ORACLE_CP_PATH` for macOS APFS clone mode; Linux encrypted cookies may need `secret-tool` (GNOME) or `kwallet-query` + `dbus-send` (KDE) unless a safe-storage password override is set |
| Profile copies | macOS uses APFS clones (`cp -cR`); Linux and Windows use Node's recursive copy |

## Providers

| Provider | Selection | Archive format | Upload ceiling | Auth transports |
| --- | --- | --- | --- | --- |
| ChatGPT | `preset` (canonical ids in `ORACLE_SUBMIT_PRESETS`; human-readable labels are normalized) | `.tar.zst` | 250 MiB | Isolated seed profile, or existing-Chrome relay |
| Grok | `mode: "heavy"` only | `.tar.gz` | 200 MiB | Isolated seed profile |

ChatGPT presets: `pro_standard`, `pro_extended`, `thinking_light`, `thinking_standard`,
`thinking_extended`, `thinking_heavy`, `instant`, `instant_auto_switch`. Grok uses `.tar.gz`
because its execution environment can lack `zstd`; manual testing against `https://grok.com`
accepted a 200 MiB upload and rejected 200 MiB + 1 byte.

## Known limits

Known limits are part of the claim; read them before installing.

- **Experimental public beta.** Provider UI, auth, model controls, and artifact download behavior
  drift; release proof is re-run per release, not continuously.
- **The `omp-oracle` name is not on npm yet.** `pi-oracle` on npm is the upstream package and does
  not carry this fork's commits. Install from the GitHub URL or a local checkout until
  `omp-oracle` is published; do not keep both installed at once, or `/oracle` commands and
  `oracle_*` tools register twice.
- **Windows native is declared, not fork-qualified.** The fork owns no Parallels lane, so the
  release gate requires macOS and Ubuntu only; Windows native support rests on upstream's
  `pi-oracle` 0.7.20 validation until a Windows lane exists.
- **Fork changes are not yet matrix-qualified.** The relay transport and OMP host compatibility
  are covered by unit and sanity tests and by the observed OMP preflight above; the Crabbox
  platform matrix and the ChatGPT preset proof have not been re-run under the `omp-oracle` name.
- **A real ChatGPT or Grok web session is required** for the provider you use, in a local
  Chromium-family browser profile.
- **Relay mode needs a capable relay.** Relay builds without `Target.getTargets` cannot serve
  `agent-browser`; relay mode is ChatGPT-only.
- **Wake-up is best effort.** Completion delivery into the host session is one attempt; the saved
  job directory is the durable record.
- **No demo media.** The README uses command-level proof and design docs; no screenshot or GIF is
  checked in.
