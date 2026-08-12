# Phase 8 change summary - Patient matching and duplicate resolution

Status: implemented locally; no remote migration or deployment has been performed.

## Delivered

- Tenant-qualified hospital and legacy patient identifiers without weakening global HID, phone, or email uniqueness.
- Versioned, project-scoped candidate sets and one active final decision per source-folder version.
- Server-side candidate generation restricted to identifier-qualified patients.
- Explainable name, DOB, and identifier feature scores with explicit conflicts and confidence bands.
- Masked candidate snapshots for the operational comparison UI.
- Manual outcomes: link existing, request new identity, review later, and escalate.
- Race-safe uniqueness preventing two simultaneous final decisions for one source version.
- Live patient-matching workspace using shared HID controls.

## Safety boundaries

- No candidate is linked automatically, including an exact candidate.
- `create_new_pending` records an identity request only. It does not fabricate an Auth user or create a canonical patient.
- No hard merge or destructive duplicate resolution is exposed.
- Broad global name search is intentionally excluded until organization-to-patient ownership is canonical.
- A wrong decision requires a separately authorized, audited revocation/correction flow before import; Phase 11 hardening completes that control.

## Verification

- Frontend production build: required before Phase 9 handoff.
- Database uniqueness/RLS/concurrency tests require an isolated retired hosted identity backend test environment.
