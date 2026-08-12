# Design system

The console's look is not a theme sitting on top of the markup — it is a small
set of rules, and every page keeps to them. This file states the rules. The
values themselves live in `apps/console/src/ui/tokens.css`, which is the source
of truth; nothing here restates a hex code that could drift from it.

`docs/console-spec.md` describes what each page *shows*. This describes what all
of them *look like*.

## The shape of it

A dark, data-dense operations console. Somebody keeps it open while an incident
is happening and reads it over someone's shoulder on a projector, so density and
legibility win over comfort, and nothing is decorative.

- **Layout** — fixed masthead, then a stats strip, then a nav rail beside a
  scrolling main column. The masthead never leaves, because the two facts it
  carries (is the feed live, which chain) are worthless if you have to scroll
  to check them. Below 1100px the rail becomes a row of tabs.
- **Emphasis** — a 3px accent left-border, and nothing else. No border-radius
  outside inline code, no box-shadow anywhere, no gradient, no fill behind
  text. Adding one shadow undoes the whole thing.
- **Headings and every label** are monospaced; body copy is the system sans.
  The mix is the point: a measured value and its label should look like data.

## The token contract

Everything comes out of `tokens.css`. Two rules make it worth having:

1. **No raw values in a component's CSS.** Every size is one of `--t-*`
   (type) or `--s1`–`--s7` (a 4px step), every colour one of the palette
   tokens. A hand-typed `0.8125rem` is a size that will not move when the
   scale does.
2. **Sizes are `rem`, not `px`.** A reader who has raised their browser's base
   size gets a bigger console, not the same cramped one. `--t-micro` (12px) is
   the floor — below that the mono labels stop being readable on a projector.

The palette is defined three times on purpose: once on bare `:root` for light,
once under `prefers-color-scheme: dark`, once under `[data-theme='dark']`. The
console stamps `data-theme="dark"` and commits to dark; light is kept whole and
working rather than deleted, because the spec rules out a *toggle*, not a
palette.

`--ink-faint` in both modes is set against `--surface-sunk` at the 0.75rem
floor — it is the colour of every eyebrow, stat label and timestamp, so it is
the one that has to clear 4.5:1. It has been darkened (light) and lifted (dark)
from the spec's value for exactly that reason.

## Status colour

`--ok` / `--warning` / `--critical` carry meaning, so they are never the only
thing carrying it:

- A severity dot is `aria-hidden` and always sits next to the severity as text.
- Status pills are outlined, never filled — a fill reads as a button.
- A configured mainnet gets its own full-width warning line, not just a
  differently coloured chip. The difference between a testnet and a mainnet is
  the whole of the risk.

## Interaction

- **Buttons** live in `ui/primitives.css`, not in a page's stylesheet: the
  masthead wears them on every route. `.button` is the default, `.button--go`
  the one that commits (signs, spends, breaks something), `.button--quiet` the
  masthead's secondary.
- **Touch targets** stay dense on a desktop and grow to a 44px minimum under
  `@media (pointer: coarse)` — the condition is the input device, not the
  window width.
- **Async controls** say what they are doing while they do it ("Opening
  KeeperHub…", "Waiting for signature…"), and where two of them sit side by
  side only the one that was pressed says so.
- **Anything that appears after an action** — an error, a confirmation, a
  refusal — is inside `role="alert"` or `role="status"`. Otherwise the visitor
  using a screen reader presses the one button on the page and hears nothing.
- **Focus** is a 2px accent outline with a 2px offset, never removed. There is
  a skip link to the main column.
- **Motion** is limited to a live-feed pulse and skeleton shimmer, and both
  stop under `prefers-reduced-motion`.

## Numbers

Anything that changes in place — counts, timers, gas, hashes — is
`font-variant-numeric: tabular-nums`, so a re-render does not shift the column.
A statistic with nothing qualifying shows an em dash, never `0`: zero would
read as instant detection, which is a claim the data does not make.
