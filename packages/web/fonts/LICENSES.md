# Font licenses

Both families are self-hosted here — no Google Fonts / external CDN requests at build or runtime
(see CLAUDE.md forkability policy: the extension/app never assumes a fixed external dependency, and
this keeps visitor requests from ever leaving the deployed origin).

## Ubuntu (`ubuntu-400.woff2`, `ubuntu-500.woff2`, `ubuntu-700.woff2`)

- **License**: Ubuntu Font Licence 1.0 — full text at <https://ubuntu.com/legal/font-licence> (also
  mirrored alongside the upstream source below).
- **Origin**: Canonical Ltd.'s official Ubuntu Font Family release, static instances
  `Ubuntu-Regular.ttf` (400), `Ubuntu-Medium.ttf` (500), `Ubuntu-Bold.ttf` (700), sourced from the
  Google Fonts repository mirror (a plain static-file git host, not the Google Fonts CDN/API):
  <https://github.com/google/fonts/tree/main/ufl/ubuntu>.
- **Processing**: subsetted to Latin + Cyrillic unicode ranges and converted to woff2 with
  `fonttools`/`pyftsubset` (no glyphs added or altered; hinting stripped, which the UFL permits for
  redistribution of modified/subset versions under the same license).

## Lora (`lora-500.woff2`, `lora-600.woff2`)

- **License**: SIL Open Font License 1.1 — full text at <https://scripts.sil.org/OFL> (also mirrored
  alongside the upstream source below).
- **Origin**: the Lora variable font (`Lora[wght].ttf`) from the Google Fonts repository mirror:
  <https://github.com/google/fonts/tree/main/ofl/lora>. Static instances at weight 500 and 600 were
  generated locally with `fonttools varLib.instancer` (a lossless, OFL-permitted derivation of the
  variable font, not a redistribution of Google's own built static files).
- **Processing**: same Latin + Cyrillic subsetting/woff2 conversion as above.

## Subsetting details

Combined Latin + Cyrillic unicode-range (matches the ranges Google Fonts itself uses for the `latin`
and `cyrillic` subsets, kept in one file per weight rather than split across multiple
`@font-face`/`unicode-range` declarations, since this app always needs both scripts on first paint —
Russian summaries alongside English/Russian UI):

```
U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,
U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,
U+2116
```

Total: ~122 KB across all five files (woff2, latin+cyrillic subset) — see the Task 22 PR report for
the per-file breakdown.
