# HID design system inventory

Status: canonical token foundation formalized on 20 July 2026.

## Source of truth

1. `src/index.css` owns the HID palette and semantic aliases.
2. `src/components/ui.tsx` owns shared buttons, fields, cards, badges, loading, empty states, modals, sheets, chips and selection controls.
3. Shared application shells remain `PortalShell`, `HospitalLayout` and `AdminLayout`; Migrate retains its workflow-specific shell while consuming global tokens.
4. Inter is the interface font. JetBrains Mono is limited to HID numbers, identifiers, logs and technical values.

## Canonical foundations

- Colors: existing `--blue`, semantic colors, text, background, surface and border values are preserved and exposed through `--color-*` aliases.
- Typography: controlled sizes from micro through display, with `-.02em` heading tracking.
- Spacing: the established 4/8/12/16/20/24/32/40/48/64/80 rhythm.
- Radius and elevation: existing HID radius and shadow values, exposed through semantic aliases.
- Controls: 44px default height and mobile touch-target baseline.
- Containers: 1200px public and 1440px operational maximums.
- Motion: 150ms fast, 200ms standard and 280ms expanded transitions.
- Responsive foundation: 1024px, 768px, 480px and 362px CSS boundaries; 1280px remains the expanded large-desktop design-QA width.

## Standardization applied

- Shared `Button`, `Input`, `Select`, `Textarea`, `Card`, `Badge`, loader, empty state and section header now consume semantic HID tokens.
- Public commercial pages consume the global palette, radius and elevation tokens.
- HID Migrate aligns its desktop/tablet/mobile thresholds and mobile touch targets with the shared foundation.
- Public and operational container utilities are available without forcing data-heavy screens into marketing widths.

## Incremental migration rule

Legacy raw values are not evidence of a new palette; most repeat the same HID colors. When a touched component already has a matching global value, replace the literal with the semantic alias. Refactor remaining legacy pages incrementally with visual regression evidence rather than a destructive global rewrite.

## Design QA matrix

Review major public, patient, hospital, Migrate and admin routes at 1440, 1280, 1024, 768, 480, 390 and 362 pixels. Verify overflow, navigation, touch targets, critical actions, tables/card conversion, form stacking, headings and state feedback.
