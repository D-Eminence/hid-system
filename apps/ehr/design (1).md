# Design System (`design.md`)

> **Historical EHR design reference.** This file does not define platform
> architecture or override [`../CODEX.md`](../CODEX.md) and the authoritative
> documents under [`../docs/`](../docs/README.md). Its visual claims require
> re-verification against the maintained implementation before reuse.

**Status:** Historical design-system proposal, originally ratified 2026-05-28.
`tokens.css` was the implementation reference for the prototype described here.
**Provenance:** anchored on confirmed Figma variables + existing code, completed
into full ramps and an accessible scale.
- **✓ confirmed** - pulled directly from Figma/code.
- **＋ completed** - designed to harmonize with the confirmed anchors, every value
  contrast-checked (numbers in §7). Verify against the Figma foundations frame if
  one is later published; values were chosen to be safe defaults, not guesses.

---

## 1. Principles

1. **Tokens only.** Components reference CSS variables, never raw hex. One change
   in `tokens.css` propagates everywhere.
2. **Accessibility is a constraint, not a polish pass.** Every text/background
   pairing in this system meets WCAG 2.2 **AA** (most hit AAA). See §7.
3. **Border-first, shadow-light.** The system reads clean and clinical - calm
   surfaces, hairline structure, shadows reserved for true elevation (modals).
4. **Color never carries meaning alone** (1.4.1). Status = color **＋** icon/label.
5. **Semantic over primitive.** Use `--text-body`, `--border-control`,
   `--accent` in components - not `--neutral-700` directly. Ramps are raw
   material; semantic aliases are the API.

---

## 2. Color

### Semantic tokens (use these in components)
| Token | Resolves to | Use |
|---|---|---|
| `--text-heading` | neutral-900 `#121212` | Page/section titles |
| `--text-strong` | neutral-800 `#2e3034` | Values, emphasized body |
| `--text-body` | neutral-700 `#484f58` | Default body & labels |
| `--text-secondary` | neutral-600 `#5f6873` | Inactive nav, captions (min readable) |
| `--text-disabled` | neutral-400 `#9aa6ad` | **Visually disabled only** - never live text |
| `--text-link` | primary-600 `#0a539e` | Links (AAA on white) |
| `--surface` / `--surface-muted` | `#ffffff` / `#f6f7f8` | Cards / app background |
| `--border-subtle` / `--border-default` | `#f2f2f2` / `#c2c9cd` | Dividers / card edges |
| `--border-control` | neutral-500 `#79838d` | **Input borders** - meets 3:1 (1.4.11) |
| `--accent` / `--accent-hover` | primary-500 / 600 | Primary actions |

### Ramps
**Neutral** 0→900: `#ffffff #f6f7f8 #f2f2f2 #e6e6e6 #c2c9cd #9aa6ad #79838d #5f6873 #484f58 #2e3034 #121212`
**Primary** 50→900: `#e6f7ff #cfecff #a3d8ff #6ec0ff #2e9bf5 #086dd9 #0a539e #0a4783 #0a3a69 #082c4f`
**Danger** (＋break-glass): `50 #fdeaea · 300 #f4222d · 500 #cf1322 · 700 #5d0012`
**Success:** `50 #e7f6ec · 500 #15803d · 600 #166534`
**Warning:** `50 #fdf1dd · 500 #b45309 · 600 #9a4f08`

### Two hard color rules
- **Danger red `#f4222d` (danger-300)** is for **framing/fills and large/bold text
  only** (4.11:1). For body-size danger text use **`#cf1322` (danger-500)**.
- **The red emergency framing is reserved for break-glass/emergency contexts**
  (see `DECISIONS.md` §3). Ordinary form errors use inline field errors in
  danger-500 - not the red card frame. Keep the frame visually exceptional.

---

## 3. Typography

**Family:** `Inter` (confirmed brand face; system stack fallback). The org system
uses a single family; if a display face is adopted later, point `--font-display`
at it - headings already use that variable.

| Role | Token | Size / line-height | Weight |
|---|---|---|---|
| Caption ＋ | `--fs-caption` | 11 / 16 | 400-500 (sparingly) |
| Body sm ✓ | `--fs-sm` | 12 / 16 | 400 / 500 / 700 |
| Body md ✓ | `--fs-md` | 16 / 24 | 400 / 600 |
| Body lg ✓ | `--fs-lg` | 20 / 32 | 700 |
| Heading sm ＋ | `--fs-h-sm` | 24 / 32 | 700 |
| Heading md ＋ | `--fs-h-md` | 30 / 38 | 700 |
| Heading lg ＋ | `--fs-h-lg` | 36 / 44 | 700 |
| Display ＋ | `--fs-display` | 48 / 56 | 700, tracking-tight |

**Base size resolved:** root/body = **16px** (`--fs-md`). This settles the old
14px(code)/12px(Figma) conflict toward readability and zoom-safety. **12px
(`--fs-sm`) is the label/metadata/dense-UI tier**, not body copy. Don't set body
text below 16px.

---

## 4. Spacing, Radius, Elevation

**Spacing** (4px base): `4 6 8 12 16 20 24 32 36 44 48 60 68` →
`--space-100 … --space-1200`. (`700=32`, `1000=48` are ＋-completed steps.)

**Radius:** `sm 4 · md 8 · lg 12 · xl 16 · 2xl 24 · pill 9999`. Cards = `2xl (24)`,
inputs/buttons = `md (8)`, chips = `lg (12)`, pills/nav = `pill`.

**Elevation:** `--shadow-xs/sm/md/lg`. Cards rest on `sm`; modals use `lg`. Prefer
borders over shadow for structure.

---

## 5. Motion & Layering

**Durations:** instant 80 · fast 120 · base 200 · slow 320 ms.
**Easing:** `--ease-standard` (most), `-decelerate` (enter), `-accelerate` (exit).
**Reduced motion:** `tokens.css` globally collapses animation/transition under
`prefers-reduced-motion` (2.3.3) - don't fight it with inline durations.
**Z-index:** dropdown 100 · sticky 200 · overlay 1000 · toast 1100 · tooltip 1200.
**Breakpoints (mobile-first):** sm 480 · md 768 · lg 1024 · xl 1280 · 2xl 1440.
Mandate: every screen ships loading / empty / error / mobile states.

---

## 6. Components

### Built (reuse - `src/components/ui.tsx`)
`Button` (variants primary/secondary/danger/ghost/outline · sizes sm/md/lg ·
loading · icon · fullWidth) · `Input` (label/error/hint/icon · password reveal) ·
`Select` · `Textarea` · `Card` (padding, onClick) · `Badge` (blue/green/red/amber/
gray) · `Spinner` · `PageLoader` *(mandated loading state)* · `EmptyState`
*(mandated empty state)* · `SectionHeader` · `Modal` (esc/backdrop/scroll-lock) ·
`ToastProvider/showToast` *(confirmations only - never the sole channel for
critical flows)*.

> Mandated **loading / empty / error** states already have homes: `PageLoader`,
> `EmptyState`, and the `error` prop on Input/Select/Textarea.

### In Figma, to build (use canonical tokens)
Top App Bar (logo · notification bell w/ count on `--danger-700` · avatar chip on
`--primary-50`) · Primary Tab Nav (active `--neutral-900` underline +
`--text-strong`; inactive **`--text-secondary`**, not disabled-grey) · Segmented
Control (track `--surface-muted`, active white pill) · Chip/Tag (outline
`--border-control`, `radius-lg`) · Icon Button (`--border-subtle`, `radius-sm`) ·
Record/Detail Card (labels `--text-body`, values `--text-strong` bold) ·
**Emergency/break-glass treatment** (`--danger-300` frame → white card →
`--danger-500` icon chip; emergency contexts only).

---

## 7. Accessibility (WCAG 2.2 AA) - verified

**Contrast (computed, on white unless noted):**

| Pairing | Ratio | Verdict |
|---|---|---|
| text-heading `#121212` | 18.73 | AAA |
| text-strong `#2e3034` | 13.22 | AAA |
| text-body `#484f58` | 8.28 | AAA |
| text-secondary `#5f6873` | 5.65 | AA |
| primary-600 link `#0a539e` | 7.65 | AAA |
| primary-500 `#086dd9` (+ white-on) | 5.00 | AA |
| danger-500 text `#cf1322` | 5.57 | AA |
| white on danger-700 `#5d0012` | 14.25 | AAA |
| success-500 `#15803d` / warning-500 `#b45309` | 5.02 | AA |
| Badges (info/success/warning/danger/neutral on tints) | 4.49-8.64 | AA-AAA |

**Three fixes applied to the original Figma tokens:**
1. **Inactive nav / secondary labels** moved off `#9aa6ad` (2.49 - fails) to
   `--text-secondary #5f6873` (5.65 AA). `#9aa6ad` survives only as
   `--text-disabled` (disabled text is contrast-exempt).
2. **Control borders** moved off `#c2c9cd` (1.68) to `--border-control #79838d`
   (3.86) so an input's edge alone meets non-text contrast (1.4.11).
3. **Danger red** restricted: `#f4222d` for framing/large only; body-size danger
   text uses `#cf1322`.

**Other requirements:**
- **Focus** always visible: 2px `--border-focus` ring, 2px offset (2.4.7/2.4.11).
- **Target size** ≥ 24×24px (2.5.8 AA); aim 44×44 for primary touch targets.
- **Don't rely on color alone** (1.4.1): status needs icon/label too.
- **Reduced motion** honored globally (2.3.3).
- **Labels** on every field; errors announced in text, not color only.

---

## 8. Migration (code → canonical) - greenlit

Branch `feature/design-system-tokens`, additive-first:
1. Drop in `tokens.css`; keep old names as temporary aliases (`--blue:var(--primary-500)`).
2. `Button`: primary `#1a6fd4→#086dd9`; danger `#dc2626→#f4222d` (fills) / text
   uses danger-500; re-base radii to scale.
3. Inputs: border→`--border-control`; focus→`--border-focus`; error→danger-500;
   label→`--text-body`.
4. `Card`: radius `14→24`; border→`--border-default`.
5. `Badge`: remap 5 colors to ramp tints + accessible badge-text tokens.
6. Text colors → semantic tokens. Base font → 16px (do this first; it cascades).
PRs include before/after screenshots (per PR rules).

---

## 9. Historical Claude-skill proposal

This system is now stable and accessible, so it is ready to be promoted into a
**`SKILL.md`** so AI-assisted builds auto-apply these tokens and reuse components.
The skill should encode: tokens-only rule, semantic-alias API, the two color
rules (§2), 16px body floor, and the three accessibility fixes (§7). `tokens.css`
ships with it as the reference implementation.

---

## 10. Remaining verification (optional, to reach "Figma-pixel-exact")

The ＋-completed values are accessible, safe defaults. If you want them confirmed
identical to Figma rather than harmonized, link these frames and I'll reconcile:
foundations/color (full ramps, success/warning) · typography (heading scale) ·
spacing (steps 700/1000) · component/UI-kit (input/modal/table states). Nothing is
blocked on this - the system is usable today.
