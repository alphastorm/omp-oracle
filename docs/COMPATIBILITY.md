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

The existing-Chrome endpoint also accepts native loopback Chrome CDP with a separate persistent
user-data directory. Instant upload/response/owned-tab cleanup and cross-origin frame capture
were exercised on macOS; a full Deep Research/export run on native CDP remains unverified.
This is not the default isolated seed-clone transport; see [setup](OPERATIONS.md#dedicated-account-in-persistent-chrome).

| Provider | Selection | Archive format | Upload ceiling | Auth transports |
| --- | --- | --- | --- | --- |
| ChatGPT | `preset` (canonical ids in `ORACLE_SUBMIT_PRESETS`; human-readable labels are normalized) | `.tar.zst` | 250 MiB | Isolated seed profile, or existing-Chrome relay |
| Grok | `mode: "heavy"` only | `.tar.gz` | 200 MiB | Isolated seed profile |
| ChatGPT Deep Research | `preset: "deep_research"` (composer tool; model picker untouched) | `.tar.zst` | 250 MiB | Existing-Chrome relay only: the report is read from the research widget's iframe through CDP frame capture; on the isolated profile the job fails with `errorCode: deep_research_report_unreadable` |

ChatGPT presets: `pro_standard`, `pro_extended`, `thinking_light`, `thinking_standard`,
`thinking_extended`, `thinking_heavy`, `instant`, `instant_auto_switch`. Grok uses `.tar.gz`
because its execution environment can lack `zstd`; manual testing against `https://grok.com`
accepted a 200 MiB upload and rejected 200 MiB + 1 byte.

## Known limits

Known limits are part of the claim; read them before installing.

- **ChatGPT's slider-based thinking-effort picker is driven by keyboard.** Since 2026-09-20 the
  composer renders the tiers (Instant, Medium, High, Extra High, Pro) as a discrete slider that
  exposes only the current stop; the worker focuses it, steps with arrow keys, and verifies each
  step from the slider's own description. Both Pro presets land on the single `Pro` stop and
  `thinking_light` shares `Medium` with `thinking_standard`; `Select model` is left on `Latest`.
  Older tier menus remain supported. The relay tab's composer keeps the last stop a job set.
- **Experimental public beta.** Provider UI, auth, model controls, and artifact download behavior
  drift; release proof is re-run per release, not continuously.
- **`pi-oracle` on npm is the upstream package**, not this fork; it must not stay installed
  alongside `omp-oracle`, or `/oracle` commands and `oracle_*` tools register twice.
- **Windows native is declared, not fork-qualified.** The fork owns no Parallels lane, so the
  release gate requires macOS and Ubuntu only; Windows native support rests on upstream's
  `pi-oracle` 0.7.20 validation until a Windows lane exists.
- **Fork qualification covers what the release ledger names.** The relay transport and OMP host
  compatibility are covered by unit and sanity tests, the live eight-preset ChatGPT proof through
  the fork's build, and the macOS and Ubuntu Crabbox lanes recorded in the
  [release ledger](RELEASE.md#fork-evidence-omp-oracle); nothing beyond those entries is claimed.
- **A real ChatGPT or Grok web session is required** for the provider you use, in a local
  Chromium-family browser profile.
- **Relay mode needs a capable relay.** Relay builds without `Target.getTargets` cannot serve
  `agent-browser`; relay mode is ChatGPT-only.
- **Deep Research reports are read through CDP frame capture (verified 2026-09-20).** The report
  renders inside a cross-origin, sandboxed ChatGPT App iframe (`internal://deep-research`) whose
  same-origin child frame holds the text; the top document keeps a model-written placeholder and
  the conversation API carries no report. The worker arms `Target.setAutoAttach` on its pinned tab
  before sending — Chrome only surfaces frames created after arming — and reads
  `frames[0].document.body.innerText` from the attached session. Relay transport only; a
  `deep_research` job on the isolated profile fails with `deep_research_report_unreadable`. Live
  proof: one job completed with a 13.5K-character report in 5 minutes. Excluded from the release
  preset proof because each run consumes a Deep Research task.
- **Deep Research native Markdown exports are collected through Chrome's download events
  (verified 2026-09-20 on Chrome 153 through the OMP relay).** The widget's Export → Export to
  Markdown menu delegates the download to the host page, so hooks inside the frame never see the
  bytes. The worker enables the `Page` domain on the pinned tab and the bound frame session,
  listens for `Page.downloadWillBegin`/`Page.downloadProgress`, and reads the bytes from the
  `Blob` it registered behind the UI's object URL. The extension relay does not route
  `Browser.setDownloadBehavior` (`chrome.debugger` clients may not write local files), so the
  worker never changes the browser's download destination and never learns the saved path: Chrome
  keeps its own copy in its configured download directory, and the worker's copy is validated
  against Chrome's declared byte count instead. Live proof: a completed job's export was
  recollected byte-identical (36,995 bytes, same SHA-256) to the file Chrome saved.
- **Wake-up is best effort.** Completion delivery into the host session is one attempt; the saved
  job directory is the durable record.
- **No demo media.** The README uses command-level proof and design docs; no screenshot or GIF is
  checked in.
