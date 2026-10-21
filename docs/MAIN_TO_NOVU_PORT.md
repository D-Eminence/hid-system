# Fixes ported from main to the production Novu branch

`staging-novu-ci-20261005` serves production. `main` recorded that branch as
merged (`7c88f0b`, "main supersedes it") without keeping its files, so Git
treats it as part of `main` and `git merge main` here would replace this
branch's applied migrations 0061–0072 with `main`'s different files of the same
numbers. Fixes therefore come over one pull request at a time, onto this
branch's own code, and every schema change is a new migration numbered after
0072.

Production admits only new migration files under `services/ehr-api/database/`
(`scripts/production_deployment_core.py`, `schema_contract`), each declared with
its SHA-256 in `config/production-schema-compatibility.json` and a named
reviewer. So these ports leave every existing file there unchanged: database
suites ported from `main` run from `services/ehr-api/test/database/`, which the
container database acceptance script runs after the suites in
`services/ehr-api/database/tests/`.

## Ported

| main | What it fixes here | Migration here |
| --- | --- | --- |
| #40 | EHR clinical lists page at the sort key's full microsecond precision | — |
| #44 | EHR sends Lab the order's exact microsecond `created_at` as `requestedAt`; 0018 already compares them exactly | — |
| #51 | A Lab result history read without `lab.execution.read` returns released revisions only; adds `GET /lab/ehr-orders/:id/released-results` | — |
| #53 | Lab, Pharmacy and EHR reuse one remote JWKS set per process | — |
| #34 | Fourteen row locks in Identity, Lab, OCR, Outreach and Pharmacy needed UPDATE privileges their runtime roles lack (42501); SERIALIZABLE retry per service | 0073 (main 0078) |
| #33 (grant) | Every Outreach runtime write failed: its RLS policies call `auth.account_id_for_subject`, which the runtime could not execute | 0074 |
| #56 | EHR can send a saved active lab request to Lab again; Lab answers acceptance refusals 4xx | — |
| #59 | Only the account that created a document upload intent completes it | — |
| #60 | A missing purpose of use is 400, not 500; an owning service refusing OCR's workload identity is 503 | — |
| #35, #36 | OCR stores transient publication failures as retryable, flags the last attempt, refuses unpublishable validations; the OCR app creates Textract jobs | — |
| #46 | EHR and OCR answer and audit a refusal made before a facility is bound instead of 503 | — |
| #38 | EHR, OCR, Lab and Pharmacy cookie GETs pass Identity's delegated check without a CSRF token | — |
| #43 | Outreach cookie reads pass without CSRF; Identity authorizes `outreach.campaign.read`; campaign writes stay refused | — |
| #45 | A correct patient PIN no longer clears the staff member's PIN failure window | 0075 (main 0079) |
| #55 | Recovery starts answer alike whether or not the account exists; wrong recovery codes share one budget per account | 0076 (main 0081) |
| #61 | Wrong public-enrollment contact codes share one budget per recipient | — |
| #33 | Lab, Pharmacy, OCR and Outreach write guards fail closed on an unresolved session; OCR worker leases | 0077 (main 0077) |
| #31 | Lab authorizes the patient before listing a specimen's executions | — |

## Not ported, and why

- Already on this branch: #26 (0071 grants the list), #58 (0071 seeds `direct-care`).
- Does not apply: #52. This branch's record summary reads only encounters, notes and imported records.
- Needs `main`'s Phase 4 platform administration (0061–0072 on `main`), which this branch replaces with its own (0064): #18, #24, #25, #27, #32, #49, #81.
- Rewrites Identity's sign-in, refresh and sign-out on `main`'s token service: #39, #42, #50, #76. Port it as its own change with `main`'s HTTP session verifiers.
- Edits a suite in `services/ehr-api/database/tests/`, which production refuses: #48 (0080 also restates `main`'s 0077 bodies).
- Needs grants in `runtime-grants.sql`: #30.
- Launch features and their infrastructure (#63–#98 except those above) were not part of this batch.

## Grants that runtime-grants.sql still needs

0074 and 0076 grant to roles that already exist, which repairs production.
`runtime-grants.sql` revokes every grant before it applies its own, so a later
role bootstrap would remove them until it carries the same statements:

```sql
-- with the hid_outreach_runtime function grants
grant execute on function auth.account_id_for_subject(text) to hid_outreach_runtime;
-- with the hid_identity_runtime and hid_schema_test_runtime table grants
grant select, insert, update on auth.otp_start_cooldowns to hid_identity_runtime;
grant select, insert, update on auth.otp_start_cooldowns to hid_schema_test_runtime;
```

Until then the container database acceptance script, which bootstraps roles
after the migrations, fails at `otp-recovery-start-cooldown.integration.sql`
and `runtime-command-privileges.integration.sql`. `main`'s Outreach
`runtime-function-grants.spec.ts` belongs with that change.
