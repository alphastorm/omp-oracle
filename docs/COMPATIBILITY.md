# OMP Oracle compatibility

This page is for anyone checking which coding-agent hosts, operating systems, browsers, providers, and sign-in transports OMP Oracle (`omp-oracle`) supports, on what evidence, and with what limits. Companion guides: [Operations](OPERATIONS.md) · [Release](RELEASE.md) · [Test plan](TEST_PLAN.md).

## Support at a glance

Scan this table for current package and runtime support before checking the evidence and limits below.

| Area | Supported | Notes |
| --- | --- | --- |
| Package | `omp-oracle` `0.4.15` on npm (`main` on GitHub) | Remove upstream `pi-oracle` before installing |
| Hosts | Oh My Pi (OMP) and `pi` (`^1.5.0` baseline) | Persisted host session required |
| Platforms | macOS and Ubuntu Linux; Windows native (declared) | Node.js `>=22.19.0`; Node 24 for release validation |
| Providers | ChatGPT (`.tar.zst`, `250 MiB`) and Grok (`.tar.gz`, `200 MiB`) | Nine ChatGPT presets; Grok `heavy` mode |
| Sign-in transports | Isolated seed profile, existing-Chrome relay, managed browser | Relay and managed browser are ChatGPT-only |

## Reading this page

Each support claim below uses one of four evidence levels.

| Status | Meaning |
| --- | --- |
| **Declared** | Package metadata allows it; not exercised by this fork |
| **Validated upstream** | Exercised by upstream `pi-oracle` release gates |
| **Observed** | Exercised by this fork and recorded in the [release ledger](RELEASE.md#evidence-ledger) |
| **Required by the release gate** | The fork's release gate fails without it |

## Hosts

OMP Oracle loads in Oh My Pi and `pi` (the coding agents that host the extension) whenever the session is persisted on disk.

| Host | Status | Basis |
| --- | --- | --- |
| `pi` 1.5.0 (baseline) | **Required by the release gate** | [Local gate](TEST_PLAN.md#local-gate) and Crabbox `real-extension` suites ([Platform smoke](PLATFORM_SMOKE.md)) against `^1.5.0` |
| `pi` 1.3.0, 1.4.0, and 0.80.9 | **Observed**; `0.80.9` **validated upstream** | Earlier fork and upstream `pi-oracle` release gates; see version history below |
| Other `pi` versions | **Declared** | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` are optional wildcard peers |
| Oh My Pi | **Observed**; **required by the release gate** | Live eight-preset ChatGPT proof (gate) plus registry-installed package runs and `omp install --dry-run` |
| Oh My Pi without Pi's trust exports | **Observed** (unit test) | Runtime asks `ctx.isProjectTrusted?.() ?? true`; standalone config load tested in `scripts/oracle-host-compat.test.mjs` |

- `pi` baseline history: the [local gate](TEST_PLAN.md#local-gate) (three typechecks, sanity harness, and native `pi` status smoke) and [Crabbox `real-extension` suites](PLATFORM_SMOKE.md) run against `pi` `1.5.0`. Earlier fork gates ran against `pi` `1.3.0` for `0.4.7`–`0.4.11`, `pi` `1.4.0` for `0.4.12`–`0.4.13`, and `pi` `0.80.9` through `0.4.6`, and upstream `pi-oracle` `0.7.19` and `0.7.20` ran against `pi` `0.80.9` (see the [release ledger](RELEASE.md#evidence-ledger)).
- Oh My Pi qualification: source-loaded isolated print-mode sessions (`omp … --no-extensions -e`; see [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof)) run the eight-preset proof, [fork evidence](RELEASE.md#fork-evidence-omp-oracle) records registry-installed jobs on Oh My Pi `18.2.6`, `18.2.7`, `18.2.11`, `18.12.3`, `18.12.6`, `18.13.3`, `18.14.1`, `18.14.2`, `18.15.0`, and `18.18.3`, and `omp install --dry-run` resolves this checkout as `omp-oracle`.
- Hosts without Pi's trust exports: at runtime, every entry point calls `ctx.isProjectTrusted?.() ?? true`, counting a host without `isProjectTrusted` as trusted and skipping an untrusted project's `oracle.json` whole (see [Config files in Operations](OPERATIONS.md#config-files)). `scripts/oracle-host-compat.test.mjs` bundles `loadOracleConfig` without `hasTrustRequiringProjectResources` or `ProjectTrustStore`, proving standalone loads skip project overrides unless `--approve` or `-a` is passed.

A persisted session is required on every host; `--no-session` runs report `oracle: unavailable`.

Oh My Pi `18.18.2` and newer can return a rejecting Promise from `sendUserMessage` when a prompt is not admitted (`PromptDroppedError`). Interactive `/oracle` and `/oracle-followup` requests remain consumed and show a warning to re-enter the command; synchronous failures are handled the same way. Older hosts that return `void` remain supported.

## Platforms and runtime

Check your operating system, Node.js runtime, browser, and helper binaries against these requirements.

| Requirement | Supported value and status |
| --- | --- |
| Operating systems | macOS and Ubuntu Linux (**required by the release gate**); Windows native (**declared** in `package.json` `os`, **validated upstream** at `pi-oracle` `0.7.20`, not re-qualified by this fork; see [Platform smoke](PLATFORM_SMOKE.md#windows-template-maintenance)) |
| Node.js | `>=22.19.0` to install, run, and pass the [local gate](TEST_PLAN.md#local-gate) (**declared** in `engines`; supplies built-in `node:sqlite` `DatabaseSync` for custom Chromium cookie reads). Node 24 is used in hosted CI and **required by the release gate** (`platform-smoke.config.mjs`) |
| Browser | Google Chrome, Chromium, or another Chromium-family browser |
| Local tools | `agent-browser` `0.41.2` or newer and `tar` on `PATH` on all platforms; `zstd` for ChatGPT `.tar.zst` archives; `cp` on `PATH` or `PI_ORACLE_CP_PATH` for macOS `apfs-clone` |
| Cookie decryption | Seed profile only ([Cookie sources](OPERATIONS.md#cookie-sources)): `@steipete/sweet-cookie`, or `auth.chromiumKeychain` on macOS; on Linux, `secret-tool`, or `kwallet-query` + `dbus-send`, or a `SWEET_COOKIE_*_SAFE_STORAGE_PASSWORD` override |
| Profile copies | Set by `browser.cloneStrategy` ([Configuration reference](OPERATIONS.md#configuration-reference)): macOS `apfs-clone` uses `cp -cR` (worker falls back to `cp -R`); Linux, Windows, and `copy` use Node's recursive copy |

- Platform tool details: Windows builds portable tar streams in Node while preflight checks `tar` on `PATH` across all platforms; `auth.chromiumKeychain` is rejected on Linux and Windows; on macOS `apfs-clone`, the job worker probes `cp -c` and falls back to `cp -R` when APFS cloning fails, while host-side seed cloning runs `cp -cR`.

### Driver version floor

OMP Oracle requires `agent-browser` `0.41.2` or newer before starting any browser session. Versions `0.40.0`–`0.41.1` can relaunch a page to `about:blank` when follow-on commands omit launch flags; see [driver #2287](https://github.com/vercel-labs/agent-browser/issues/2287). Versions `0.39.1` and older can run commands in a fresh local browser after a connected browser disappears; see [driver #2155](https://github.com/vercel-labs/agent-browser/issues/2155).

Preflight reports the `0.41.2` floor and upgrade command when `agent-browser` is older or unreadable. The job worker, [recollection](OPERATIONS.md#recollect-a-finished-answer), and `/oracle-auth` repeat the check before their first browser command: a queued job fails after a downgrade with `errorCode: "agent_browser_unsupported"` and `promptSendState: "not_sent"` ([Error codes](OPERATIONS.md#error-codes)); recollection and `/oracle-auth` fail directly without setting `agent_browser_unsupported`.

<a id="providers"></a>
## Providers and transports

Each provider pairs an archive format and upload ceiling after [default exclusions and pruning](SECURITY.md#what-leaves-the-machine) with specific sign-in transports (how a job reaches a signed-in provider session).

| Provider | Selection | Archive limit | Transports and status |
| --- | --- | --- | --- |
| ChatGPT model presets | Eight model presets (default `pro_extended`) | `.tar.zst`, `250 MiB` | Seed profile (default), relay, or managed browser; **required by the release gate** on shared Chrome |
| ChatGPT Deep Research | `preset: "deep_research"` (composer tool) | `.tar.zst`, `250 MiB` | Relay or managed browser only; **observed** |
| Grok | `mode: "heavy"` only | `.tar.gz`, `200 MiB` | Seed profile only; not exercised by the fork's release gate (upstream manual upload testing is recorded below) |

- Preset ids and labels (`pro_standard`, `pro_extended`, `thinking_light`, `thinking_standard`, `thinking_extended`, `thinking_heavy`, `instant`, `instant_auto_switch`, and `deep_research`, defined in `ORACLE_SUBMIT_PRESETS`) are listed in [Providers and presets in the README](../README.md#providers-and-presets); human-readable labels normalize to their canonical preset ids.
- Transport setup is covered in [Existing-Chrome relay](OPERATIONS.md#existing-chrome-relay-chatgpt-only) and [Managed ChatGPT browser](OPERATIONS.md#managed-chatgpt-browser-dedicated-account); [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof) exercises the eight model presets through the operator's configured relay or managed browser, and [fork evidence](RELEASE.md#fork-evidence-omp-oracle) records per-release runs.
- `deep_research` turns on the composer tool without changing the model picker and fails on the isolated seed profile with `deep_research_report_unreadable`; for capture internals, see [Collection in Architecture](ARCHITECTURE.md#collection).
- Upload ceilings apply after default exclusions and whole-repo pruning. Grok uses `.tar.gz` because its execution environment can lack `zstd`; manual testing against `https://grok.com` accepted a `200 MiB` upload and rejected `200 MiB` + `1 byte`.
- `browser.chatGptRelayEndpoint` also accepts a [dedicated account in persistent Chrome](OPERATIONS.md#dedicated-account-in-persistent-chrome) over native loopback Chrome DevTools Protocol (CDP): `instant` preset upload, response capture, owned-tab cleanup, and cross-origin frame capture are **observed** on macOS there. Deep Research with native Markdown export is **observed** through the managed browser and Oh My Pi relay; manual persistent Chrome has no recorded Deep Research run.

## Known limits

Read these support boundaries before installing or choosing a transport:

- **ChatGPT's thinking-effort slider shares stops.** The slider has five stops: `Instant`, `Medium`, `High`, `Extra High`, and `Pro`. `pro_standard` and `pro_extended` both land on `Pro`; `thinking_light` and `thinking_standard` both land on `Medium`; `thinking_extended` lands on `High` and `thinking_heavy` on `Extra High`. `Select model` stays on `Latest`, and older tier menus remain supported.
- **The slider setting is saved to your account.** The last stop a job sets stays selected afterwards, and the redesigned ChatGPT shell saves it to the account (`user_last_used_model_config`), making it the default in your other chats and browsers.
- **Experimental public beta.** Provider UI, sign-in flows, model pickers, and artifact downloads can drift between provider updates; qualification runs per release rather than continuously.
- **Upstream `pi-oracle` must not stay installed alongside `omp-oracle`.** `pi-oracle` does not carry fork changes, and keeping both packages installed registers `/oracle` commands and `oracle_*` tools twice.
- **Windows native is declared, not fork-qualified.** The release gate requires macOS and Ubuntu only because the fork maintains no Windows validation environment; Windows native support rests on upstream `pi-oracle` `0.7.20` validation (see [Platform smoke](PLATFORM_SMOKE.md#windows-template-maintenance)).
- **Fork qualification covers only what the release ledger and automated gates run.** Each release records the [local gate](TEST_PLAN.md#local-gate), offline capture proof, live eight-preset ChatGPT proof, and macOS and Ubuntu Crabbox suites ([Platform smoke](PLATFORM_SMOKE.md)) in [fork evidence](RELEASE.md#fork-evidence-omp-oracle); nothing beyond those checks and unit tests is claimed.
- **A real ChatGPT or Grok web session is required.** You must be signed in to the provider you use, in a local Chromium-family browser profile or in the managed ChatGPT profile.
- **Relay mode is ChatGPT-only and needs `Target.getTargets`.** CDP relays that omit `Target.getTargets` cannot serve `agent-browser` (`0.41.2` or newer).
- **Managed-browser open-profile detection relies on POSIX `SingletonLock`.** On Windows, a managed profile already open without Oracle's DevTools endpoint is detected only when Chrome launch hands off to it. On every platform, creating the first job tab in a managed Chrome that Oracle opens focuses the browser window (see [Managed ChatGPT browser](OPERATIONS.md#managed-chatgpt-browser-dedicated-account)).
- **Other browser tools on a shared Chrome can navigate a job's tab.** Moving a running job's tab to another page forces the worker to reopen its conversation at the cost of time (see [Do not drive the managed Chrome while jobs run](OPERATIONS.md#do-not-drive-the-managed-chrome-while-jobs-run)).
- **Deep Research requires shared Chrome and is excluded from the preset proof.** `deep_research` runs only on the existing-Chrome relay or managed browser (up to `90 minutes` by default) and fails on the isolated seed profile with `deep_research_report_unreadable`. The [ChatGPT preset proof](RELEASE.md#chatgpt-preset-proof) skips `deep_research` (`release:proof:chatgpt-presets`) because each run spends an account task; see [Collection in Architecture](ARCHITECTURE.md#collection).
- **Wake-ups are best effort.** The session poller attempts idle-gated wake-up delivery to the asking session at most three times, `0 s`, `15 s`, and `60 s` apart. When the asking session is gone, another saved session in the same project can deliver the wake-up instead. The job directory under `${PI_ORACLE_JOBS_DIR:-/tmp}/oracle-<job-id>/` is the durable record (see [Check status and read the answer](OPERATIONS.md#check-status-and-read-the-answer)).
