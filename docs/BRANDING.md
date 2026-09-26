# OMP Oracle — brand spec

Identity for `alphastorm/omp-oracle`: the extension that lets Oh My Pi or `pi` hand hard,
long-running work to ChatGPT or Grok through the web app and keep working while the answer is
produced.

**Brand sibling of [OMP Session Gateway](https://github.com/alphastorm/omp-session-gateway) and
[OMP NInfer](https://github.com/alphastorm/omp-ninfer).** OMP Oracle shares the family ground,
neutrals, type, kinship rule, and voice register defined by the gateway; this file is the complete
authority for the OMP Oracle identity. Live emerald `#31C48D` belongs to the gateway and Local violet
`#8E7BE8` to NInfer; the retired signal blue `#3FA9DC` and exec amber `#E0A33E` stay retired.

## Naming and message

- Repository: `alphastorm/omp-oracle`. npm package: `omp-oracle`. Display name: **OMP Oracle**.
- `pi-oracle` is the upstream package; never present it as an install path for this fork.
- Category: **asynchronous web oracles for coding agents**.
- Headline: **Send the hard question. Keep working.** The README's long form adds the providers
  and the payoff: "Send the hard question to ChatGPT or Grok. Keep working. Read the answer when it
  lands."
- Entity grammar: *Oh My Pi or pi (the host coding agent) → OMP Oracle (the extension) → ChatGPT or
  Grok (the web provider, on the operator's own subscription).* Spell out "Oh My Pi" before using
  "OMP" on any surface that can be read standalone.
- Proof comes from what the product does, stated as the site states it: a context-rich repository
  archive, an isolated browser session, the answer saved to disk, one wake-up for the session that
  asked, the operator's own subscription instead of an API key.

## The mark: "The Lens"

Two brackets frame the project context the agent packs; the dot at their focal point is the answer
that comes back. Geometry (96×96 viewBox, all radii 2). Each bracket is a post with both arms laid
over its ends, so its corners stay whole:

- left post `x12 y16 w10 h64`; arms `x12 y16 w22 h10` and `x12 y70 w22 h10`
- right post `x74 y16 w10 h64`; arms `x62 y16 w22 h10` and `x62 y70 w22 h10`
- dot `cx48 cy48 r8` in Answer rose

Rules, the family's numbers:

- Never use upstream OMP's π-with-plug mark or derivatives of it.
- Clearspace: one dot diameter (16 units) on all sides. Minimum size 16px.
- The dot is always Answer rose; the frame is Ink on dark surfaces (`logo.svg`) or Ink-dark on light
  surfaces (`logo-light.svg`). Never recolor, and never give the dot a sibling's accent.

## Color

The family ground and neutral ramp: `ground #060809`, `ink-dark #0B0E11`, `surface #0E1319`,
`border-subtle #161C22`, `border #1C232B`, `ink #E8ECEF`, `body #B6BEC7`, `muted #8A939D`.
OMP Oracle owns:

| Token | Hex | oklch | Use |
|---|---|---|---|
| answer | `#DE82B7` | oklch(0.72 0.13 345) | the dot, links, eyebrows, the primary action, focus rings |
| answer-hover | `#EDA4CC` | oklch(0.80 0.10 345) | link and action hover |
| kinship | `#F97316` | — (upstream orange) | citation micro-dot only; see the rule below |

Answer rose sits in the widest open gap of the family wheel, between NInfer violet (289°) and the
shared danger red (28°), and clear of ChatGPT green and of the red the unrelated Oracle company
uses, so it implies no provider partnership. It measures 7.6:1 against `ground`, and `ink-dark` text
on it measures 7.4:1. Danger red `#C85045` stays the family error color; never use rose for errors.

**Kinship rule (the gateway's):** upstream orange appears at most once per surface, only as a
micro-dot (≤5px UI, ≤8px artwork) beside an Oh My Pi mention — never in the mark, never on
interactive elements, never as a fill.

## Type

- **Public site:** system font stacks only — `system-ui, sans-serif` and `ui-monospace, monospace`.
  No remote fonts, scripts, stylesheets, or CDNs.
- **Exported artwork:** `assets/banner.html` and `assets/og.html` use Space Grotesk 500/600 and
  JetBrains Mono 400/500, imported from Google Fonts by `assets/brand.css` at render time. Never copy
  that import into the site.
- Wordmark: "OMP Oracle", weight 600, letter-spacing −0.015em. Mono eyebrows: 11–12px, uppercase,
  letter-spacing 0.16–0.18em.

## Voice

Sober and exact, in the gateway's register: sentence case except mono eyebrows, no emoji, no
exclamation marks. Every claim on an owned surface already appears in the README, the site, or
`docs/`. Artwork carries no version, date, preset list, or measured number, so it never goes stale
between releases. Keep the standing disclaimer: "Community project; not affiliated with or endorsed
by the Oh My Pi maintainers, the `pi-oracle` maintainer, OpenAI, or xAI." Never set ChatGPT, Grok,
OpenAI, xAI, or OMP marks on an owned surface.

## Asset inventory

Paths are relative to the repository root. `assets/` and `site/` are repository-only; the npm
package does not ship them.

| File | Purpose |
|---|---|
| `assets/logo.svg` | mark for dark backgrounds; site header mark and README dark mode |
| `assets/logo-light.svg` | mark for light backgrounds; README light mode |
| `assets/favicon.svg` | site favicon (96, rx22 tile) |
| `assets/brand.css` | shared tokens and primitives for the artwork sources |
| `assets/banner.html` | banner source (1280×320) |
| `assets/banner.png` | rendered banner @2x (2560×640) |
| `assets/og.html` | social preview source (1280×640) |
| `assets/og.png` | GitHub social preview and site `og:image` (1280×640) |
| `site/` | public site (`alphastorm.github.io/omp-oracle`), system font stacks only. `.github/workflows/pages.yml` stages `logo.svg`, `favicon.svg`, and `og.png` from `assets/` at deploy time, so `site/` never carries copies |

`npm run test:site`, part of `npm run verify:oracle`, fails when a site page references an asset the
deployment would not serve, when a staged asset's source could change without redeploying the site,
when `og:image:width`/`og:image:height` disagree with `og.png`, or when the sitemap, `robots.txt`,
and canonical links disagree about the site's pages.

## Regeneration

After editing an artwork source, run `npm run render:assets`. It renders `banner` and `og` with
headless Chrome (from `--chrome <path>`, `CHROME`, `PATH`, or the default install) and verifies each
PNG's dimensions; name targets to render only some (`npm run render:assets -- og`). The render
needs network access for the webfonts. `npm run render:assets -- --check` renders without writing
and fails when a committed PNG no longer matches its source. Byte equality holds only for the Chrome
build and fonts that produced the committed PNG, so `--check` is a same-machine check and stays out
of the local gate.

## README header

The theme-aware mark heads the centered header block, as in the gateway README:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
  <img src="assets/logo-light.svg" alt="" width="72" height="72">
</picture>
```

Badges are shields.io flat style, one row, `labelColor 0B0E11`, values in `border` `#1C232B` or
Answer rose `#DE82B7` — never green or red status colors.

## GitHub social preview

GitHub has no API for the repository social preview. After changing `assets/og.png`, upload it at
GitHub → Settings → General → Social preview.

## Relationship to upstream

Independent community project; not affiliated with or endorsed by the Oh My Pi maintainers or the
`pi-oracle` maintainer. "OMP" appears in the name as plain nominative reference; do not restyle
upstream's logo.
