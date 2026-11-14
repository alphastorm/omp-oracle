# OMP Oracle — brand spec

This specification is for anyone editing a public OMP Oracle (`alphastorm/omp-oracle`) surface — the README, the public site, or the brand artwork — so every surface applies the same identity. OMP Oracle (`omp-oracle`) is the extension that lets Oh My Pi (OMP) or `pi` hand hard, long-running work to ChatGPT or Grok through the web app and keep working while the answer is produced.

**Brand sibling of [OMP Session Gateway](https://github.com/alphastorm/omp-session-gateway) and [OMP NInfer](https://github.com/alphastorm/omp-ninfer).** OMP Oracle shares the family ground, neutrals, type, kinship rule, and voice register defined by the gateway; this file is the complete authority for the OMP Oracle identity. Live emerald `#31C48D` belongs to the gateway and Local violet `#8E7BE8` to NInfer; do not use the family's retired signal blue `#3FA9DC` or exec amber `#E0A33E`.

## Naming and message

Use these exact names, grammar, and proof claims across public surfaces:

- Repository: `alphastorm/omp-oracle`. npm package: `omp-oracle`. Display name: **OMP Oracle**.
- `pi-oracle` is the upstream package; never present it as an install path for this fork.
- Category: **asynchronous web oracles for coding agents**.
- Headline: **Send the hard question. Keep working.** The README's long form adds the providers and the payoff: "Send the hard question to ChatGPT or Grok. Keep working. Read the answer when it lands."
- Entity grammar: *Oh My Pi or `pi` (the host coding agent) → OMP Oracle (the extension) → ChatGPT or Grok (the web provider, on the operator's own subscription).* Spell out "Oh My Pi" before using "OMP" on any surface that can be read standalone.
- Proof comes from what the product does, stated as the site states it: a context-rich repository archive, an isolated browser session, the answer saved to disk, one wake-up for the session that asked, the operator's own subscription instead of an API key.

## The mark: "The Lens"

Two brackets frame the project context the agent packs; the dot at their focal point is the answer that comes back. Geometry (`96×96` `viewBox`, bracket corner radii `2`): each bracket is a post with both arms laid over its ends so its corners stay whole:

- left post `x12 y16 w10 h64`; arms `x12 y16 w22 h10` and `x12 y70 w22 h10`
- right post `x74 y16 w10 h64`; arms `x62 y16 w22 h10` and `x62 y70 w22 h10`
- dot `cx48 cy48 r8` in Answer rose (`answer`, `#DE82B7`)

Apply the family's mark rules without exception:

- Never use upstream OMP's π-with-plug mark or derivatives of it.
- External clearspace: one dot diameter (`16` units) on all sides around the rendered mark. Minimum size `16px`.
- The dot is always Answer rose (`#DE82B7`); the frame is Ink (`ink`, `#E8ECEF`) on dark surfaces (`logo.svg`) or Ink-dark (`ink-dark`, `#0B0E11`) on light surfaces (`logo-light.svg`). Never recolor, and never give the dot a sibling's accent.

## Color

The family ground and neutral ramp are `ground #060809`, `ink-dark #0B0E11`, `surface #0E1319`, `border-subtle #161C22`, `border #1C232B`, `ink #E8ECEF`, `body #B6BEC7`, and `muted #8A939D`. OMP Oracle owns these accent tokens:

| Token | Hex | oklch | Use |
|---|---|---|---|
| `answer` | `#DE82B7` | `oklch(0.72 0.13 345)` | the dot, links, eyebrows, the primary action, focus rings |
| `answer-hover` | `#EDA4CC` | `oklch(0.80 0.10 345)` | link and action hover |
| `kinship` | `#F97316` | — (upstream orange) | citation micro-dot only; see the kinship rule below |

Answer rose sits in the widest open gap of the family `oklch` hue wheel, between NInfer violet (`289°`) and the shared danger red (`28°`), and clear of ChatGPT green and of the red the unrelated Oracle company uses, so it implies no provider partnership. It measures `7.6:1` against `ground`, and `ink-dark` text on it measures `7.4:1`. Danger red `#C85045` stays the family error color; never use rose for errors.

Kinship rule (the gateway's): upstream orange appears at most once per surface, only as a micro-dot (`≤5px` UI, `≤8px` artwork) beside an Oh My Pi mention — never in the mark, never on interactive elements, and never as a container, badge, or surface fill.

## Type

Public site and exported artwork use Space Grotesk and JetBrains Mono under separate delivery rules:

- Public site: self-hosted latin subsets in `site/fonts/` are first-party assets — Space Grotesk (variable weight `300–700`) for the wordmark and headings, and JetBrains Mono (variable weight `100–800`) for eyebrows, pills, and code, while body text stays on the system sans stack.
- Font licenses and script rule: both font subsets come from the OMP Session Gateway site, with OFL-1.1 license texts in `licenses/fonts/space-grotesk/` and `licenses/fonts/jetbrains-mono/`. Use no remote fonts, scripts, stylesheets, or CDNs; the inline copy-button enhancement (making no network, storage, or analytics calls) is the only executable site script.
- Exported artwork: `assets/banner.html` and `assets/og.html` use Space Grotesk `500`/`600` and JetBrains Mono `400`/`500`, imported from Google Fonts by `assets/brand.css` at render time. Never copy that import into the site.
- Wordmark: "OMP Oracle", weight `600`, letter-spacing `−0.015em`. Mono eyebrows: `11–12px`, uppercase, letter-spacing `0.16–0.18em`.

## Voice

Write in a sober, exact voice in the gateway's register: sentence case except mono eyebrows, no emoji, and no exclamation marks. Every claim on the site or in artwork must match a claim in [the README](../README.md) or `docs/`, and artwork carries no version, date, preset list, or measured number so it stays current across releases.

Keep the standing disclaimer: "Community project; not affiliated with or endorsed by the Oh My Pi maintainers, the `pi-oracle` maintainer, OpenAI, or xAI." Never set ChatGPT, Grok, OpenAI, xAI, or OMP marks on an owned surface.

## Asset inventory

Paths below are relative to the repository root; `assets/` and `site/` are repository-only and are not shipped in the npm package.

| File | Purpose |
|---|---|
| `assets/logo.svg` | mark for dark backgrounds; site header mark and README dark mode |
| `assets/logo-light.svg` | mark for light backgrounds; README light mode |
| `assets/favicon.svg` | site favicon (`96`, `rx22` tile) |
| `assets/brand.css` | shared tokens and primitives for the artwork sources |
| `assets/banner.html` | banner source (`1280×320`) |
| `assets/banner.png` | rendered banner `@2x` (`2560×640`) |
| `assets/og.html` | social preview source (`1280×640`) |
| `assets/og.png` | GitHub social preview and site `og:image` (`1280×640`) |
| `site/` | public site (`alphastorm.github.io/omp-oracle`), first-party fonts as specified above; `.github/workflows/pages.yml` stages `logo.svg`, `favicon.svg`, and `og.png` from `assets/` at deploy time, so `site/` carries no copies |

`npm run test:site` (part of `npm run verify:oracle`) checks staged brand assets, `og.png` dimensions, and page metadata coherence; see [Local gate](TEST_PLAN.md#local-gate).

## Regeneration

After editing an artwork source, run `npm run render:assets` to render `banner` and `og` with headless Chrome (from `-- --chrome <path>`, `CHROME`, `PATH`, or the default install) and verify each PNG's dimensions; pass target names to render a subset (`npm run render:assets -- og`). Rendering requires network access for the webfonts.

`npm run render:assets -- --check` renders without writing and fails when a committed PNG does not match its source. Because byte equality holds only for the Chrome build and fonts that produced the committed PNG, `--check` is a same-machine check and stays out of the local gate.

## README header

The centered `<div align="center">` header block opens [the README](../README.md) in a fixed order, matching the gateway README: the `72px` theme-aware mark, `# OMP Oracle`, the bold headline, the bold compatibility line, one short paragraph stating what the extension does, the navigation link row, the flat badges, and the `<sub><strong>Private by design:</strong> …</sub>` line, followed outside the centered block by the fork-note blockquote and the status and standing-disclaimer paragraph:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
  <img src="assets/logo-light.svg" alt="" width="72" height="72">
</picture>
```

Badges are shields.io flat style, one row, `labelColor 0B0E11`, values in `border` `#1C232B` or Answer rose `#DE82B7` — never green or red status colors. The CI badge is the one exception: its value is the workflow status in shields.io's own colors, as in the sibling READMEs.

## GitHub social preview

GitHub exposes no API for the repository social preview. After changing `assets/og.png`, upload it manually at GitHub → Settings → General → Social preview.

## Relationship to upstream

Community project; not affiliated with or endorsed by the Oh My Pi maintainers, the `pi-oracle` maintainer, OpenAI, or xAI. "OMP" appears in the name as plain nominative reference; do not restyle upstream's logo.
