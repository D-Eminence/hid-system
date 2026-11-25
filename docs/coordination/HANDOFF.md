# Coordinator handoff: state at 25 Nov 2026, about 15:30 UTC

This file is for a coordinator session that takes over: a new cloud session, or the owner's local Claude Code in VS Code. It is not product documentation. The clinical lead's and DPO's names stay out of the repository and GitHub. The owner knows them.

## Only one coordinator acts at a time
- Before acting, the owner tells this session it is the active coordinator.
- Any other coordinator stops merging, releasing and pushing until the owner hands back.
- At handback, update this file and push it to `claude/coordinator-state` (PR #333, never merge).
- The incoming coordinator starts by re-checking live state: the open PRs, the latest "Production backend candidates" and "Production frontend candidates" runs, and #332. Do not trust this file blindly.

## Rules (all still in force)
- **Signatures and decisions** count only when the owner sends them verbatim in the active coordinator's chat. GitHub comments all come from one account, so they cannot prove who wrote them. Record every one verbatim in `owner-decisions.md`.
- **DB migrations** need the owner's signature on the exact sha256 of each file. The declaration is `config/production-schema-compatibility.json`, with `reviewed_by` and `review_reference` "SIGNED: owner D-Eminence, verbatim …". The declared files must equal the changed DB files. Sign `runtime-grants.sql` only when it changes.
- **Rahman's final DB check comes before every backend release.** This rule was added after #330 went out early.
- **Releases never overlap**, and the website and backend share a lease.
- **Re-pin the website** (`config/production-release-dependencies.json` in health) right after every backend release, using each service's `source_commit` from the candidate artifact. A stale pin fails with `REQUIRED_BACKEND_NOT_DEPLOYED`.
- **Gateway VEX** (`security/gateway-runtime.vex.json`) is bound to the sha256 of `gateway/Dockerfile`, `nginx.conf.template` and `proxy-headers.conf`. Any change to them needs a re-review and an owner confirmation (Q291 A covers Billing's routes).
- **Release test 67** fails on any `security/` path text inside gated folders, comments included.
- **AWS and Terraform:** only the owner applies, after saying "apply" on the exact plan. Never delete in production, never touch the AWS SigV4 secret, and never sign in to production with an automated browser.
- **No secrets** in chat, git, files or command lines.
- **Git:** a new `claude/` branch per change. Use merge commits on other people's branches; never force-push, amend or rebase them. No model IDs in commits or PRs.
- **DB work** only on throwaway clusters with fictional data.
- **Wording:** plain English; "NIN Verified"/"NIN Not Verified"; no "permission" wording on staff screens; Health IDs never in URLs.
- **Website-only fixes** ship once reviewed and green (Q94 4).

## Live in production
- **Backend:** `backend-45502696619-1-956b7cb17fc4bf33`, hid-system `95fa1e52`, migrations 0001–0151. The other services stay on `d519e5d1` (Release C).
- **Website:** health main `8168ec3d`, Release D (classic parity 257 of 257: 195 rows done and 62 done by decision). Live 25 Nov 01:25 UTC as `frontend-45524832398-1-3524ef584f6736bc`.
- **Pins:** identity, ehr, ocr and outreach on `95fa1e52`; the rest on `d519e5d1`.

## Next releases, in order (one at a time)
1. **Release E, hid-system#338** (branch `claude/backend-release-e`). It contains 0152 diagnosis search and 0153 recent diagnoses (Ola's ORD-9), plus #307's ORD-3 batch.
   - Signed by the owner about 13:50 UTC on 25 Nov: 0152 `abfecc35…`, 0153 `45faa6a7…`, runtime-grants `49b378f5…`. The fallback declaration (0153 only) was signed in advance.
   - Validation: release tests 126 of 126; the rehearsal against the live tree passed; a stop after 0152 was reproduced.
   - **Waits on Rahman's final check.** Then merge it, watch "Production backend candidates", and re-pin the website (ehr-api and database-migration at least).
   - If the release stops after 0152, the runbook is in the PR body: finish the migrations before re-running the grants.
2. **Gateway fix, hid-system#339** (branch `claude/gateway-apk-pins-20261125`, head `933e1954`, CI green). It pins libexpat 2.11.0-r0 and OpenSSL 3.5.9-r1, and moves the VEX to 3.5.9-r1 (Q291 A, Q292 A). This must ship before any backend build: the old libexpat pin breaks every build.
   - Follow-up: `security/production-runtime-assessment.json` still says 3.5.9-r0 for the gateway. Update it with the next backend-image change.
3. **Lekan's website batch:** health #313 (role labels, `9ea9c69a`), #314 (routed details warning, `a45112d7`) and #234 (own-work Health ID, `dc1ca553`). All passed independent review with no defects (25 Nov). Add #331 (P2-4, Lagos time) after its review, then merge as one website release.

## Two-week sprint (approved 25 Nov; ends about 9 Dec)
- 100% means classic parity, plus Akos's EHR list, plus every new department (Q146 B), each as a first working version. Items that need outside approval (video provider, SMS sender ID, live HMO portals, offline legal) are built but switched off.
- Second reviewer: an independent agent review plus Rahman's final check.
- Readiness (Q147 A, three equal parts, live features only): about 43%. Classic 100%; EHR list about 29% (19 of 66); departments 0 of 20.

### Wave 1: outpatient and cashier (backend unsigned)
| Department | Backend | Migrations | Website | State |
|---|---|---|---|---|
| Appointments | hid-system#335 (`63312e5f`) | 0160–0161 | health#328 | Review fixes done; next is Rahman's check, then the signature |
| Billing release 1 and pharmacy stock | hid-system#336 (`9b36fa6e`) | 0162–0167 | health#329 | Adds 7 `/api/v1/commercial/*` nginx routes. Needs the VEX re-bind after #339 merges |
| Emergency board and triage | hid-system#337 | 0168–0169 | health#330 | CI green; next is Rahman's check, then the signature |

- On sprint branches, release tests 45, 53 and 99 fail with `missing migration prefix`. This is expected from the numbering gap and closes at integration.

### Wave 2: inpatient (being built)
- ADT 0170–0173 and nursing 0174–0177, on branch `claude/sprint-inpatient-backend` and its website branch.

### Later waves
Maternity, theatre, blood bank, radiology, claims, stock and procurement, roster and HR, quality, dental, reports, referrals, telemedicine, ambulance, i18n, P2-1, facility setup, subscription and the staff inbox. Surveys are in `roadmap.json`.

## Migration numbering
| Range | Owner |
|---|---|
| 0152–0153 | Ola (Release E) |
| 0154 | Ola, refills (#331, `44d96bec`; the clinical lead countersigns, Q158) |
| 0155–0159 | Ola (confirmed) |
| 0160–0169 | Sprint wave 1 |
| 0170–0177 | Sprint wave 2 (ADT, nursing) |
| 0180–0183 | Ola's moved items (ORD-10 phase 2, lab one-person check, discussed, ORD-8) |
| 0190+ | Later departments |

## Team (sessions don't wake from GitHub; the owner relays, and the team reads hid-system#258)
- **Rahman** (database, identity, release): final checks on #338, #339 and wave 1; review of Ola's 0155–0159 and 0180–0183 notes; then refills #331, `createdByMembershipId` and the SX-8 flag for #323; then SX-6, SX-7, ID-8 and CHW-1; then his tooling fixes #325 and #326.
- **Ola** (orders, pharmacy, lab; clinical owner for medicines): waits on Rahman for 0154; brings ORD-8 and ORD-11 forward. ORD-10 phase 2 is blocked on the WHOCC terms (Q165 A); the owner has the drafted email. Also #312 (code list) and #315 (OCR drug list).
- **Lekan** (website): five screens (ID-6, SX-10, MY-1, EHR-C8a/b, Q132 A), plus front desk marking a visit entered in error.

## Owner queue: hid-system#332
- **Ready now:** activate the `frontdesk@` and `nurse@` QA logins (Forgot password); test a doctor starting a reading on Migrate; turn on Usage credits; send the WHOCC email.
- **Coming:** sign 0154 and 0160–0177 as each is ready; apply #323 after Rahman adds the SX-8 flag.
- **Clinical lead and DPO packs:** plain English, never code. The lists are in #332.

## Plan files in this folder
- `owner-decisions.md`: every decision and signature, verbatim (names redacted).
- `roadmap.json`: department surveys and the six phases.
- `inventory.json`: 66 Akos-list features, each with its backend and website status.
- `parity-plan.json`: the classic parity rows and their classes.
