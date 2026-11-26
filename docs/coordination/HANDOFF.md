# Coordinator handoff: state at 26 Nov 2026, about 10:30 UTC

This file is for a coordinator session that takes over: a new cloud session, or the owner's local Claude Code in VS Code. It is not product documentation. The clinical lead's and DPO's names stay out of the repository and GitHub. The owner knows them.

**ACTIVE COORDINATOR: none. The local VS Code session (active from 25 Nov ~21:00 UTC) stopped on the owner's "stop" at about 10:35 UTC on 26 Nov. Whichever session the owner names next takes over; until then, nobody merges, releases or pushes.**

**Read "Overnight" and "Local work not yet on GitHub" first.** Five local workflows were running. From about 23:30 UTC on 25 Nov their agents failed with "API Error: Connection refused", and the session then restarted. Workflow runs resume only within the same session, so treat all five as dead. Their partial work exists only in local worktrees under `/home/l2e/hid/`. Nothing has been merged or released since website release F (25 Nov 18:01 UTC).

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

## Live in production (unchanged since 25 Nov 18:01 UTC)
- **Backend:** Release E, `backend-45657497614-1-9ad293c7963d6f06`, hid-system `0cfddcc9` (release branch `staging-novu-ci-20261005`), migrations 0001–0153. Live 25 Nov 17:04 UTC; 0152 and 0153 applied with no stop.
- **Website:** release F, health main `b44b0d56` (run 45670779345, 25 Nov 18:01 UTC): Lekan's #313, #314, #234 and P2-4 #331. All nine backend pins are on `0cfddcc9` (health#333).
- **GitHub flakiness (25 Nov afternoon):** merge and comment calls returned 500/502/504 or empty bodies but often succeeded anyway. Re-read state before retrying, and guard merges with `sha=`. Once, a push to health main started no release run; dispatch `production-frontends.yml` on main.

## Next releases, in order (one at a time; Rahman's 21:48 order, accepted in #258 7177085826)
1. **0154 refills** (Ola's #331, `9d41866c`). The fixes are **not started**: `wt-ord12` is empty.
   - Needed: Rahman's #331 review 7168468937 (lock `pharmacy.dispensing_reversals` with a busy case; a flat progress statement; contiguous fill numbers; no future `dispensed_at`; wording; case 14f).
   - Also: accept exactly `zz_billing_stock_and_gate:commercial.hook_dispensing():7:O` as an optional sixth trigger on `pharmacy.dispensings`.
   - Then the interim gate (below), the owner's signature on the new sha256s, the release, and the re-pin.
2. **Appointments #335**, renumbered at integration to follow 0154. 3. **Billing #336.** 4. **Emergency #337.** One department per release, each built on a staging that holds the previous one. Then wave 2 (#343).
- **Interim release gate (owner, 25 Nov ~23:10 UTC, "Agent check stands in"):** Rahman's `check:db` (from `a8d99ac1`) in a Docker harness, plus an independent agent review of the final renumbered files. **The harness was never built** (its agent failed), and pgvector isn't on the host. Build it first: image `hid-pg16-vector:local` (postgres:16 plus pgvector) exists, and needs Node 24 added.
- **Sprint websites** (health #328, #329, #330, #335, #336) go out only after their backends are live. Their features stay behind flags that are off.
- Follow-up: `security/production-runtime-assessment.json` still says 3.5.9-r0 for the gateway. Update it with the next backend-image change.
- **The owner wrote "signed" at about 00:30 UTC on 26 Nov, with nothing ready to sign. It is not recorded as a signature:** no file or sha256 was named. Post exact signing text on #332 when 0154 is ready.

## Overnight (25–26 Nov): what got done, and what died
- **Pushed:** only #335, `claude/sprint-appointments-backend` at `d7511876`. It has Release E merged in, Rahman's four should-fix points and nits, and round 1 review fixes, with an unsigned declaration: 0160 `39920022…`, 0161 `7343d3cc…`, runtime-grants `e65d9f52…`.
- **Decisions posted on #258:**
  - wave 1 tolerant preconditions (7174680244);
  - Rahman's release order, and the exact trigger pins (7177085826);
  - facility items reach Billing by option 2: 0163 accepts `HID-FACILITY`, and 0166/0167 match by code pair (7177222281);
  - CHW-1's registration number is optional;
  - #340's `createdByName`: yes;
  - revoking TEMP from PUBLIC comes after wave 1.
- **Review findings worth knowing:**
  - #337's 0168 leaves its new identity sequence open to the runtime grants (the same bug Rahman found in 0160).
  - The Billing website showed stock batches as expired a day early.
  - One verifier in wf_9f4a817c-565 attached reasons to the wrong findings, so re-verify anything taken from that run.
- **Lesson:** five workflows (about 30 agents) at once coincided with the connection failures. Run at most two at a time.

## Local work not yet on GitHub (checked 26 Nov 10:27 UTC)
| Worktree (`/home/l2e/hid/…`) | Branch | Local state | Where it stopped / next |
|---|---|---|---|
| wt-appt | claude/sprint-appointments-backend | pushed at `d7511876`; 1 uncommitted file | Round 2: security clean; mechanics found 2, both confirmed. The fix died midway. Finish the 2 fixes, re-hash, update the declaration, push. |
| wt-bill | claude/sprint-billing-backend | 5 local commits (`f804c9e8`), clean | The first pass is committed: the 0164 temp-table escalation removed, tolerant 0162/0167, the declaration. Security review r1 found nothing; mechanics review r1 died. Next: the mechanics review, then Rahman's full check 7175546496, his 21:48 items (0162 compares only its own rows; a fill-aware refill hook in 0167; Emergency's two triggers accepted exactly), and option 2 (0163 accepts `HID-FACILITY`). Then push. |
| wt-ed | claude/sprint-emergency-backend | no new commits; 6 uncommitted files | Review r1 confirmed 10 of 11, including the ED history sequence grant (reported twice). The fix died midway. Redo the fix from the confirmed list, then apply Rahman's #337 check 7175564791. |
| (none) | claude/sprint-inpatient-backend (#343) | untouched | Known bug: 0171's waiting-list admission doesn't set 0168's board closing marker. Fix it against Emergency's final 0168. |
| wt-web-328 | claude/sprint-appointments-web | 23 local commits (`ef04d47d`), clean | Release F merged in, the display helpers, and round 1 fixes (9 confirmed). The round 2 review died. Review, then push. |
| wt-web-329 | claude/sprint-billing-web | 6 local commits (`8a9afb18`), clean | 15 confirmed (1 blocking: after payment, the sale hand-over fails on a stale version). The fix died after some commits. Check which of the 15 remain, finish, push. |
| wt-web-330 | claude/sprint-emergency-web | 14 uncommitted files | 11 confirmed; the fix died midway. Finish, commit, review. |
| wt-web-335 | claude/sprint-adt-web | 4 local commits (`5f4fb89e`), clean | 14 confirmed and fixed. The round 2 review found 3, and their verification died. Verify, fix, push. |
| wt-web-336 | claude/sprint-nursing-web | 4 local commits (`a7f736f6`); 1 uncommitted | 12 confirmed; the fix died partway. Finish, review, push. |
| wt-display | claude/display-followups (new) | 1 commit (`338f2a98`: age from the Lagos day) | Still to do: Nigerian landlines, foreign number grouping and the `(0)` trunk, `isAdult` on the Lagos day. |
| wt-w3-*-be | claude/sprint-{radiology,bloodbank,referrals,dental,quality,hr,reports}-backend (new) | a contract commit each; quality and hr also have their first migration commit | Partial builds are **uncommitted**: dental 12 files, hr 10, quality 4, referrals 9, reports 8. Radiology and blood bank have only their contracts. |
| wt-w3-*-web | claude/sprint-{dental,hr,quality,referrals,reports}-web (new) | uncommitted: dental 13, hr 15, quality 13, referrals 16, reports 1 commit plus 10 | Partial. Radiology and blood bank websites were never started. |
| wt-blue-q132a | claude/blue-q132a-changed-after-dispensing (new) | 2 uncommitted files | The builder died early. |
| created, nothing done | wt-ord12, wt-ord11, wt-ord7fac, wt-nameonly, wt-ord9rank, wt-selfcheck, wt-sx6(-web), wt-sx7(-web), wt-id8(-web), wt-chw1(-web), wt-blue-c8, wt-blue-id6, wt-blue-my1, wt-blue-sx10 | at their base | Nothing built. The check:db harness wasn't built, and #342 wasn't reviewed. |

**How to pick this up:** start fresh agents on the existing worktrees, telling each where its predecessor stopped (this table plus `git status` / `git log`). Don't discard uncommitted files: a new agent should read them first. Keep the order: 0154 and the harness, then #335's round 2, then #336, then #337. Website and wave 3 work can run alongside, one workflow at a time.

## Two-week sprint (approved 25 Nov; ends about 9 Dec)
- 100% means classic parity, plus Akos's EHR list, plus every new department (Q146 B), each as a first working version. Items that need outside approval (video provider, SMS sender ID, live HMO portals, offline legal) are built but switched off.
- Second reviewer: an independent agent review plus Rahman's final check.
- Readiness (Q147 A, three equal parts, live features only): **about 43%, unchanged since 25 Nov.** Classic 100%; EHR list about 29% (19 of 66); departments 0 of 20. Release E's diagnosis search is live, but its list is empty in production. Release F was labels, warnings and date/phone formats. No department is live yet.

### Wave 1: outpatient and cashier (backend unsigned)
| Department | Backend | Migrations | Website | State |
|---|---|---|---|---|
| Appointments | hid-system#335 (`d7511876`, pushed) | 0160–0161 | health#328 | Rahman's fixes and round 1 fixes pushed; round 2's 2 fixes still to do (see the local work table) |
| Billing release 1 and pharmacy stock | hid-system#336 (GitHub `6b253568`; local `f804c9e8`) | 0162–0167 | health#329 | Blocking items from Rahman remain; VEX re-bound to its nginx routes in `d0516f81` (Q291 A) |
| Emergency board and triage | hid-system#337 (`db83d733`) | 0168–0169 | health#330 | Review r1: 10 confirmed; fix not finished; Rahman's check 7175564791 pending |

- On sprint branches, release tests 45, 53 and 99 fail with `missing migration prefix`. This is expected from the numbering gap and closes at integration.

### Wave 2: inpatient
- ADT 0170–0173 and nursing 0174–0177 on hid-system#343 (`ad5080bc`), with websites health#335 (ADT) and #336 (nursing). It depends on wave 1 (0171 needs 0168) and has the board-marker bug above.

### Wave 3 (provisional numbers, #258 7175611427)
Radiology 0181–0185, Blood bank 0186–0190, Referrals 0191–0193, Dental 0194–0196, Quality 0197–0198, HR/rosters 0199–0202, Reports 0203–0204. Branches `claude/sprint-<dept>-backend` and `claude/sprint-<dept>-web`.

### Wave 4 and later
Maternity, theatre, ICU, telemedicine, ambulance, claims, and stock and procurement (they build on admission or billing), then i18n, P2-1, facility setup, subscription and the staff inbox. Surveys are in `roadmap.json`.

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
| 0205–0209 | SX-6 0205, SX-7 0206, ID-8 0207–0208, CHW-1 0209 (provisional) |
| 0210+ | Free. ORD-10 phase 2 takes the next number when WHOCC answers; wave 4 booked per department on #258 |

## Team (sessions don't wake from GitHub; the owner relays, and the team reads hid-system#258)
- **Rahman, Ola and Lekan have been away since about 23:00 UTC on 25 Nov.** The owner asked the coordinator to carry their waiting work (#258 7177085826 and 7177222281 list the assignments and branches). Overnight, none of it got further than the local work table shows.
- **Rahman** (database, identity, release): his last posts are the wave 1 release order (#258 7175579690), his #336 full check (7175546496), his #337 check (7175564791) and #340's `createdByName` (7175912738, done). Coordinator-assigned in his absence: SX-6 0205, SX-7 0206, ID-8 0207–0208, CHW-1 0209, the check:db harness, and a review of #342. When he's back: he re-checks anything released under the interim gate.
- **Ola** (orders, pharmacy, lab; clinical owner for medicines): his last post is 7170418151 (working on 0154's fixes, then the notes). Assigned in his absence: the 0154 fixes, ORD-11 0159 (blocking: each notice stores its recipient), 0155, 0156 (released alone), 0157, 0158 and 0179 (on 0156), 0178, and 0180 (on all of them). ORD-10 phase 2 waits for WHOCC (Q165 A). Also #312 and #315.
- **Lekan** (website): said on 24 Nov (7147764788) that his five blue screens (ID-6, SX-10, MY-1, EHR-C8a/b, Q132 A) were being built locally. They were never pushed. Rebuilds were assigned (`claude/blue-*`) but not done. **Ask Lekan for his local versions before rebuilding.** SX-10 should show #340's `createdByName`. C8a is offered to whoever holds `ehr.encounter.write`, front desk included. Also the display follow-ups.

## Owner queue: hid-system#332
- **Ready now:** activate the `frontdesk@` and `nurse@` QA logins (Forgot password); test a doctor starting a reading on Migrate; turn on Usage credits; send the WHOCC email.
- **Coming:** sign 0154, then each wave 1 department's renumbered files, as each is ready. Apply #323 together with #341 (the SX-8 flag is done, in #341). **Nothing is ready to sign now.**
- **Clinical lead and DPO packs:** plain English, never code. The lists are in #332.

## Plan files in this folder
- `owner-decisions.md`: every decision and signature, verbatim (names redacted).
- `roadmap.json`: department surveys and the six phases.
- `inventory.json`: 66 Akos-list features, each with its backend and website status.
- `parity-plan.json`: the classic parity rows and their classes.
