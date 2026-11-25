# Coordinator handoff: state at 25 Nov 2026, about 17:20 UTC (local VS Code coordinator handing back)

This file is for a coordinator session that takes over: a new cloud session, or the owner's local Claude Code in VS Code. It is not product documentation. The clinical lead's and DPO's names stay out of the repository and GitHub. The owner knows them.

**ACTIVE COORDINATOR: the local VS Code session, since 25 Nov ~21:00 UTC (the owner chose "Hand over to this session" in the local chat). The cloud session must not merge, release or push until the owner hands over again.** Website release F (health#334, `b44b0d56`, run 45670779345) is live; the cloud coordinator shipped it at 18:01 UTC.

## Only one coordinator acts at a time
- Before acting, the owner tells this session it is the active coordinator.
- Any other coordinator stops merging, releasing and pushing until the owner hands back.
- At handback, update this file and push it to `claude/coordinator-state` (PR #333, never merge).
- The incoming coordinator starts by re-checking live state: the open PRs, the latest "Production backend candidates" and "Production frontend candidates" runs, and #332. Do not trust this file blindly.

## Rules (all still in force)
- **Signatures and decisions** count only when the owner sends them verbatim in the active coordinator's chat. GitHub comments all come from one account, so they cannot prove who wrote them. Record every one verbatim in `owner-decisions.md`.
- **DB migrations** need the owner's signature on the exact sha256 of each file. The declaration is `config/production-schema-compatibility.json`, with `reviewed_by` and `review_reference` "SIGNED: owner D-Eminence, verbatim …". The declared files must equal the changed DB files. Sign `runtime-grants.sql` only when it changes.
- **Rahman's final DB check comes before every backend release.** This rule was added after #330 went out early.
  - **While Rahman is away (owner, 25 Nov ~23:10 UTC, "Agent check stands in"):** his exact `check:db` script, run through the Docker harness `/home/l2e/hid/tools/check-db-docker.sh`, plus an independent agent review on the final renumbered files stands in. The owner still signs every migration, and Rahman re-checks after he returns.
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
- **Backend:** Release E, `backend-45657497614-1-9ad293c7963d6f06`, hid-system `0cfddcc9` (staging `staging-novu-ci-20261005`), migrations 0001–0153. It went live 25 Nov 17:04 UTC; 0152 and 0153 applied with no stop, and the fallback declaration was not used. All 13 components were rebuilt from `0cfddcc9`.
  - Before it: #339 gateway pins, `backend-45649090315-1-03d2b78867300345` (`557cddb5`), live 16:06 UTC, no migration.
- **Website:** re-pin health#333 merged as `42c548d0`, with all nine pins on `0cfddcc9`. Its release, run 45661915015, succeeded (`frontend-45661915015-1-121b98b576f44645`). Release F (Lekan's batch #313, #314, #234, #331) followed at 18:01 UTC (`b44b0d56`, run 45670779345, success).
  - Last confirmed live: `frontend-45654205866-1-68900f164538dd64` (`59cc1b04`, pins on `557cddb5`) at about 16:50 UTC.
- **GitHub flakiness on 25 Nov afternoon:** merge and comment calls returned 500/502/504 or empty bodies, but often succeeded anyway. Always re-read state before retrying, and guard merges with `sha=`. Once, a push to health main started no release run; the coordinator dispatched `production-frontends.yml` on main.

## Next releases, in order (one at a time)
1. **Confirm website run 45661915015** (above).
2. **Lekan's website batch:** health #313 (role labels, `9ea9c69a`), #314 (routed details warning, `a45112d7`), #234 (own-work Health ID, `dc1ca553`) and #331 (P2-4 Lagos time, `a3ea3039`). Merge them as one website release.
   - All four passed independent review. #331's review (25 Nov ~16:00) said ship. Two low-severity follow-ups for Lekan:
     - Nigerian landlines (`+2341…`) show in international form, not `01 234 5678`.
     - Some foreign numbers group oddly, and a stored `(0)` trunk stays in.
     - Also unconfirmed: zoneless timestamps still use the device zone; `ageInYears` would be off by one if a date of birth ever arrives as an instant; `paperRecordsWording.ts:110` `isAdult` uses UTC.
   - Check each PR is still at the reviewed head and green; refresh against main with a merge commit if needed.
3. **0154 refills (#331 in hid-system, Ola):** Rahman reviewed it (#331 7168468937). Before signing, 0154 must lock `pharmacy.dispensing_reversals`, then be re-hashed. The progress statement grows with fills (about 1.8 s at 12 fills); a better shape was suggested. `check:db` on Release E plus #331 passed. Then: owner signature, Rahman's final check, release, re-pin. The clinical lead countersigns the refill calls (Q158) before `PRESCRIPTION_REFILLS_ENABLED` goes on.
4. **Sprint wave 1** (#335–#337): each needs its agent review, then Rahman's final check, then the signature. #336 still needs the VEX re-bind for its nginx routes (Q291 A), now on top of #339's VEX.
- Follow-up: `security/production-runtime-assessment.json` still says 3.5.9-r0 for the gateway. Update it with the next backend-image change.
- Rahman's #340 (`createdByMembershipId`, no migration) and #341 (SX-8 Terraform flag, into #323) are green and await coordinator review. #340 asks for a yes from the coordinator or the owner before adding `createdByName` (it shows a colleague's name on each case). Not yet answered.

## Two-week sprint (approved 25 Nov; ends about 9 Dec)
- 100% means classic parity, plus Akos's EHR list, plus every new department (Q146 B), each as a first working version. Items that need outside approval (video provider, SMS sender ID, live HMO portals, offline legal) are built but switched off.
- Second reviewer: an independent agent review plus Rahman's final check.
- Readiness (Q147 A, three equal parts, live features only): about 43%. Classic 100%; EHR list about 29% (19 of 66); departments 0 of 20.

### Wave 1: outpatient and cashier (backend unsigned)
| Department | Backend | Migrations | Website | State |
|---|---|---|---|---|
| Appointments | hid-system#335 (`63312e5f`) | 0160–0161 | health#328 | Review fixes done; next is Rahman's check, then the signature |
| Billing release 1 and pharmacy stock | hid-system#336 (`9b36fa6e`) | 0162–0167 | health#329 | Adds 7 `/api/v1/commercial/*` nginx routes. #339 is live, so the VEX re-bind (Q291 A) can be done now |
| Emergency board and triage | hid-system#337 | 0168–0169 | health#330 | CI green; next is Rahman's check, then the signature |

- On sprint branches, release tests 45, 53 and 99 fail with `missing migration prefix`. This is expected from the numbering gap and closes at integration.

### Wave 2: inpatient (being built)
- ADT 0170–0173 and nursing 0174–0177, on branch `claude/sprint-inpatient-backend` and its website branch.

### Running on the local machine (25 Nov ~22:00 UTC; local commits until the coordinator pushes)
| Workflow | Work | Worktrees |
|---|---|---|
| wf_877a0c93-e09 | #335 Appointments and #336 Billing: Rahman's fixes, 2-lens review + adversarial verify, then a six-order wave 1 apply check | /home/l2e/hid/wt-appt, wt-bill |
| wf_9f4a817c-565 | #337 Emergency, then #343 Inpatient (0171 board-marker fix); health #328 #329 #330 #335 #336 | wt-ed, wt-inpatient, wt-web-<pr> |
| wf_3cbe4e94-299 | Wave 3: radiology, blood bank, referrals, dental, quality, HR/rosters, reports (backend + website each) | wt-w3-<dept>-be, wt-w3-<dept>-web |
If this session dies, these commits exist only in those local worktrees: push each branch before anything else.

### Wave 3 (provisional numbers, #258 7175611427)
Radiology 0181–0185, Blood bank 0186–0190, Referrals 0191–0193, Dental 0194–0196, Quality 0197–0198, HR/rosters 0199–0202, Reports 0203–0204. Branches `claude/sprint-<dept>-backend` and `claude/sprint-<dept>-web`.

### Later waves (wave 4: maternity, theatre, ICU, telemedicine, ambulance, claims, stock)
Maternity, theatre, blood bank, radiology, claims, stock and procurement, roster and HR, quality, dental, reports, referrals, telemedicine, ambulance, i18n, P2-1, facility setup, subscription and the staff inbox. Surveys are in `roadmap.json`.

## Migration numbering (settled 25 Nov ~17:00 UTC, #258 7168672285)
Numbers are bookings, given finally at integration in release order. A later release closes up to the next free numbers if an earlier booked file isn't ready, and the owner signs after renumbering. A file requires markers only for the earlier files whose objects it uses.

| Range | Owner |
|---|---|
| 0152–0153 | Ola (Release E) |
| 0154 | Ola, refills (#331; the clinical lead countersigns, Q158) |
| 0155–0159 | Ola (ORD-7 facility items, names-only, ORD-9 ranking, ORD-6, ORD-11) |
| 0160–0169 | Sprint wave 1 |
| 0170–0177 | Sprint wave 2 (ADT, nursing) |
| 0178–0180 | Ola: lab self-check (0178), "Discussed with the patient" (0179), ORD-8 (0180) |
| 0181–0204 | Wave 3 (provisional, see above) |
| 0205+ | Free. ORD-10 phase 2 takes the next number when WHOCC answers; wave 4 booked per department on #258 |

## Team (sessions don't wake from GitHub; the owner relays, and the team reads hid-system#258)
- **Rahman** (database, identity, release): #338 and #339 done. He has reviewed all six of Ola's design notes (0155/0156, 0158, 0159, 0181/0182 now 0178/0179, 0183 now 0180); 0159 has one blocking point (each notice stores its recipient). Next: 0154's lock fix, then final checks on wave 1; then refills #331, `createdByMembershipId` and the SX-8 flag for #323; then SX-6, SX-7, ID-8 and CHW-1; then his tooling fixes #325 and #326.
- **Ola** (orders, pharmacy, lab; clinical owner for medicines): renumber the notes to 0178/0179/0180 (#258 7168672285) and apply Rahman's review points; 0154 lock fix; brings ORD-8 and ORD-11 forward. ORD-10 phase 2 is blocked on the WHOCC terms (Q165 A); the owner has the drafted email. Also #312 (code list) and #315 (OCR drug list).
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
