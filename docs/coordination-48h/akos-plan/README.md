# Akos handover plan: who builds what (3 Nov 2026)

Akos is not building with the team for now. The owner asked for his work to be shared out. `backend-plan.md` is the full plan; its Part 4 has the order. The owner's answers are in `../owner-decisions.md`, decision 25: all recommended except D5 (anyone the patient shares with may open the card, read only), and D13 (legal sign-off before patient files and card links go live).

Steps 1 and 2 are live. The plan's migration numbers are replaced:

| Step | What | Plan number | Now | Builder |
|---|---|---|---|---|
| 3 | Patient details on this facility's own lab and pharmacy work | 0106 | **0113** | Ola |
| 4 | Prescription strength, form, duration, priority | 0107 | **0114** | Ola |
| 5 | Outreach follow-ups, referrals, names, link by Health ID | 0108 | **0115** | Lekan |
| 6 | Records patients add themselves (text) | 0109 | **0116** | Rahman |
| 7 | Patient files (kept off until legal signs off) | 0110 | **0117** | Lekan |
| 8 | Card link with a one-time code (kept off until legal signs off) | 0111 | **0118** | Rahman |
| - | Outreach: registering a patient into a campaign is refused at the demo (fix if real) | - | **0120** | Lekan |

The rules for every builder:
- Draft PRs only. Backend PRs go into hid-system `staging-novu-ci-20261005`; website PRs go into health `main`. The coordinator merges.
- Every migration follows the 0102/0103 pattern, with `reviewed_by` empty; the owner signs.
- Use only throwaway PostgreSQL 16 clusters.
- Steps 7 and 8 ship switched off.
