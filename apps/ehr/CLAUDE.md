# CLAUDE.md - project playbook (for AI agents & devs)

This EHR-specific playbook supplements, and never overrides, [`../CODEX.md`](../CODEX.md)
or the authoritative platform documentation under [`../docs/`](../docs/README.md).
Read those sources first, then use `README.md` and `ARCHITECTURE.md` for local
runtime detail. The Babel-in-browser guidance below applies only to the retained
reference bundle; the maintained TypeScript client and NestJS API follow their
own module documentation.

## What this project is
The **HID** healthcare suite - React-18-in-browser prototypes (no build step) on one design system. Flagship: `HID EHR.html`. See README for the file→app map.

## Golden rules
1. **Design system is binding.** Visuals come from `tokens.css` + `ehr-theme.css`. Never invent colors/type/spacing.
2. **Brand color = blue + white + grey/greyscale + black ONLY.** Blue is the ~15% accent. No green/red/amber/purple/orange - not even for success/danger. Positive→blue, caution→grey, critical→near-black. If you need emphasis, use darkness/weight, not hue.
3. **Tokens only.** `var(--token)` - never a raw hex. Look up the real name in the CSS first; an unresolved `var()` silently falls back to browser default.
4. **IDs in monospace.** HID numbers, invoice/lab/MRN ids → wrap in `className="mono"` (JetBrains Mono, scoped in ehr-theme.css).
5. **Everything is built from `primitives.jsx`.** Reuse `Button/Card/Badge/Icon/SectionHeader/EmptyState/PageLoader`. Don't hand-roll buttons.

## Babel-in-browser constraints (will break the app if ignored)
- Each `<script type="text/babel">` has its own scope. To share, end the file with `Object.assign(window, { … })`.
- **Never** declare a top-level `const styles = {…}` - name it uniquely (`labStyles`) or inline. Collisions across files crash everything.
- Use `className`, close every element, double-quote attributes (the editor direct-edits the DOM).
- New file? Add its `<script type="text/babel" src="…">` to the app's HTML in dependency order (deps before dependents; `*-app.jsx` last).

## How to extend HID EHR (most common task)
- **New module/screen:** add a NAV item in `ehr-data.jsx` → add a `case` in the `switch(nav)` in `ehr-app.jsx` → build the screen with `PageHead` + `primitives`. If it belongs to a department, add its id to that department's `modules:[]` in `DEPARTMENTS` so it's gated by config.
- **New role:** add to `ROLES` (with `tier`, `nav`, `home`) in `ehr-data.jsx`; add a dashboard in `ehr-dashboards.jsx` (`ROLE_DASH[key]`) or it falls back to ops. Gate it via a department's `roles:[]` if it shouldn't always exist.
- **New department/specialty:** add to `DEPARTMENTS` with its `modules`/`roles`; it auto-appears in the Setup Wizard and generates its nav/roles when enabled.
- **Dashboard widgets:** follow the FlowBooks KPI pattern already in `ehr-dashboards.jsx` (label + icon chip + value + footer strip). Quick-action row first, then KPIs, then content - generous spacing (`--space-600`+ between sections).

## Routing & state (no Redux)
`ehr-app.jsx` `App()` holds reference-bundle state and a `switch(nav)` router.
Pass props down. Patient lookup is not authorization: production consult flows
must satisfy server-side purpose, facility, permission, consent, and break-glass
rules before protected records are returned, as required by the platform
security and interface contracts.

## Verify before finishing
1. `show_html` the file → `get_webview_logs`. The only acceptable console line is the Babel "in-browser transformer" warning.
2. A JS error blanks the screen - if blank, check the latest edited file for scope/`styles` collisions or a bad `var()`.
3. Check it at desktop AND ~390px (mobile bottom-nav + drawer should appear; rows stack).

## Don'ts
- Don't edit `* -  Standalone.html` (compiled output) - edit sources and re-bundle.
- Don't add filler/dummy content. Don't add hue. Don't bypass `primitives`.
- Don't normalize fixture casing/enums - they stand in for a real contract.
