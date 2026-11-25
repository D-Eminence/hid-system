# Coordinator handoff: state at 25 Nov 2026, about 00:40 UTC

This file is for a new coordinator session. It is not product documentation. Names of the clinical lead and the DPO are kept out of the repository; the owner knows them.

## Live in production
- **Backend:** `backend-45502696619-1-956b7cb17fc4bf33` (hid-system `95fa1e52`), migrations 0001–0151.
  - 0147–0149: release C, 24 Nov 19:47 UTC.
  - 0150 (Q141 B, doctors start readings) and 0151 (QA-2, the front-desk and nurse QA logins): 24 Nov 22:52 UTC.
  - The other services stay on `d519e5d1`.
- **Website:** health main.
  - Release C, the #318 Migrate fix, #317 (Next.js 16.4.6) and the re-pins #319 and #323.
  - Last website release: `frontend-45506726871-1-a92ce16ed9e21e09`, 24 Nov 23:12 UTC.
  - Pins: identity, ehr, ocr and outreach on `95fa1e52`; the rest on `d519e5d1`.
- **Rule:** re-pin the website (`config/production-release-dependencies.json`) right after every backend release. A stale pin fails the website release with `REQUIRED_BACKEND_NOT_DEPLOYED`.

## Owner decisions and process
- The full log is `owner-decisions.md` in this folder.
- **The owner queue is hid-system#332.** Every decision or signature waiting on the owner is listed there, with exact text. The owner signs only in the coordinator's chat: GitHub comments all come from one account, so they cannot prove who wrote them.
- **The two-week sprint is approved (25 Nov):** 100% means classic parity, plus Akos's EHR list, plus every new department (Q146 B), each as a first working version. Items that need outside approval (video provider, SMS sender ID, live HMO portals, offline legal) are built but switched off.
- **Second reviewer:** an independent agent review plus Rahman's final database check.
- **Clinical lead and DPO:** named and available. Send them plain-English review packs, never code.
- **Readiness (Q146 B, equal weights):** about 40% on 24 Nov. Classic parity was 75% measured (about 82% counting decisions), Akos's EHR list about 40%, departments 0 of 20.

## In flight when this was written
- **Website release D** (classic parity to 100%): the six parity batches health #320, #321, #322, #324, #325 and #326, all reviewed and green. They are being merged into branch `claude/web-release-d`, together with the 3.3-68 labels, the 3.3-50 frame part and the parity doc totals. Then: review, CI, merge and release.
- **Sprint wave 1 (coordinator's agents):**
  - the decision sheet (Q147 onward) posted to #332;
  - Phase 1 departments, each with a contract section in EHR_PLANNED_CONTRACT, a backend draft PR and a website draft PR:
    - Appointments, provisional 0160–0161, branches `claude/sprint-appointments-*`;
    - Billing release 1 with pharmacy point-of-care stock, 0162–0167, `claude/sprint-billing-*`;
    - the Emergency board, 0168–0169, `claude/sprint-emergency-*`.
- **Team tasks:** posted on hid-system#258 on 24 Nov at about 22:00 UTC.
  - **Rahman:** review #320 and #321 (0152 and 0153, Ola's ORD-9), then SX-6, SX-7, ID-8 and CHW-1, then port the older backend PRs, then #325 and #326.
  - **Ola:** 0154 refills, the rest of ORD-7, the #307 refresh, ORD-6, ORD-11, ORD-10 phase 2, the lab one-person check, ORD-8.
  - **Lekan:** #313, #314 and #234; blue screens for ID-6, SX-10, MY-1, EHR-C8a/b and Q132 A; the parity doc refresh after release D.

## Plan files in this folder
- `roadmap.json`: department surveys, six phases and the challenger's corrections.
- `inventory.json`: 66 Akos-list features, each with its backend and website status.
- `parity-plan.json`: the 64 classic rows and their classes.

## Phases (two-week compression)
| Days | Work |
|---|---|
| 1–2 | Phase 0 finish, and the decisions sitting |
| 2–5 | Outpatient and cashier (appointments, billing, stock, ED); start inpatient |
| 5–9 | Inpatient (ADT, nursing, ICU); start maternity, theatre, blood bank and radiology |
| 9–12 | Back office (claims, stock and procurement, roster and HR, quality, dental, reports); network (referrals, telemedicine, ambulance, i18n, P2-1) |
| 12–14 | Full end-to-end test and go-live checks |
