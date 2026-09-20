# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability
reporting: [Report a vulnerability](https://github.com/alphastorm/omp-oracle/security/advisories/new).

Include the affected version or commit, the host (Oh My Pi or `pi`) and its version, the
transport (isolated seed profile or existing-Chrome relay), and reproduction steps. Redact
cookies, tokens, profile paths, and provider conversation contents.

## Scope

The threat model, what leaves the machine, and what is out of scope are documented in
[`docs/SECURITY.md`](docs/SECURITY.md). Provider-side handling of uploaded archives and prompts
is governed by your ChatGPT or Grok account, not by this extension.

## Supported versions

The latest commit on `main` and the most recent published `omp-oracle` release receive fixes.
`pi-oracle` on npm is the upstream package; report issues in its code to
[`fitchmultz/pi-oracle`](https://github.com/fitchmultz/pi-oracle) unless they are specific to
this fork.
