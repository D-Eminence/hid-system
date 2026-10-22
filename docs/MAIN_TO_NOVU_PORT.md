# Fixes ported from main to the production Novu branch

`staging-novu-ci-20261005` serves production. `main` recorded that branch as
merged (`7c88f0b`, "main supersedes it") without keeping its files, so Git
treats it as part of `main` and `git merge main` here would replace this
branch's applied migrations 0061–0072 with `main`'s different files of the same
numbers. Fixes therefore come over one pull request at a time, onto this
branch's own code, and every schema change is a new migration numbered after
0072.

Production admits only new migration files under `services/ehr-api/database/`,
plus `runtime-grants.sql` (below), each declared with its SHA-256 in
`config/production-schema-compatibility.json` and a named reviewer
(`scripts/production_deployment_core.py`, `schema_contract`). So these ports
leave every other existing file there unchanged: database suites ported from
`main` run from `services/ehr-api/test/database/`, which the container database
acceptance script runs after the suites in `services/ehr-api/database/tests/`.

## Ported

| main | What it fixes here | Migration here |
| --- | --- | --- |
| #40 | EHR clinical lists page at the sort key's full microsecond precision | — |
| #44 | EHR sends Lab the order's exact microsecond `created_at` as `requestedAt`; 0018 already compares them exactly | — |
| #51 | A Lab result history read without `lab.execution.read` returns released revisions only; adds `GET /lab/ehr-orders/:id/released-results` | — |
| #53 | Lab, Pharmacy and EHR reuse one remote JWKS set per process | — |
| #34 | Fourteen row locks in Identity, Lab, OCR, Outreach and Pharmacy needed UPDATE privileges their runtime roles lack (42501); SERIALIZABLE retry per service | 0073 (main 0078) |
| #33 (grant) | Every Outreach runtime write failed: its RLS policies call `auth.account_id_for_subject`, which the runtime could not execute | 0074, runtime-grants.sql |
| #56 | EHR can send a saved active lab request to Lab again; Lab answers acceptance refusals 4xx | — |
| #59 | Only the account that created a document upload intent completes it | — |
| #60 | A missing purpose of use is 400, not 500; an owning service refusing OCR's workload identity is 503 | — |
| #35, #36 | OCR stores transient publication failures as retryable, flags the last attempt, refuses unpublishable validations; the OCR app creates Textract jobs | — |
| #46 | EHR and OCR answer and audit a refusal made before a facility is bound instead of 503 | — |
| #38 | EHR, OCR, Lab and Pharmacy cookie GETs pass Identity's delegated check without a CSRF token | — |
| #43 | Outreach cookie reads pass without CSRF; Identity authorizes `outreach.campaign.read`; campaign writes stay refused | — |
| #45 | A correct patient PIN no longer clears the staff member's PIN failure window | 0075 (main 0079) |
| #55 | Recovery starts answer alike whether or not the account exists; wrong recovery codes share one budget per account | 0076 (main 0081), runtime-grants.sql |
| #61 | Wrong public-enrollment contact codes share one budget per recipient | — |
| #33 | Lab, Pharmacy, OCR and Outreach write guards fail closed on an unresolved session; OCR worker leases | 0077 (main 0077) |
| #31 | Lab authorizes the patient before listing a specimen's executions | — |
| #18 | The admin console's Platform controls page: the Identity runtime may run both control commands, and `platform.admin_set_control` no longer fails with 42702; its refusals answer 409/403/400 | 0078 (main 0071), runtime-grants.sql |
| #18 | The admin console's Audit page: `audit.list_platform_events` returns `patient_id` in its declared column instead of failing with 42804 | 0079 (main 0067) |
| #88 | CAC sign-up reads the Java-printed registration date that QoreID's CAC Basic v2 returns in production | — |
| #88 | Termii receives the SMS recipient as international digits without `+`, as its API documents | — |
| — | This branch only: OCR publication answers 503 `OCR_PUBLICATION_PAUSED` until `OCR_PUBLICATION_ENABLED=true` on ocr-api. It ships before the migration that lets publication commit, so no running ocr-api (during a rollout or after a rollback) can publish before the owner decides | — |
| #32 (7B) | The OCR patient-confirmation and validation guards refuse a missing source, extraction, account or membership, and bind the confirming account and membership to the session | 0080 (main 0076) |
| #30 | OCR patient confirmation and publication can write their outbox events (every one failed with 42501); a repeated confirmation answers 409 `OCR_PATIENT_ALREADY_CONFIRMED` | 0081 (main 0075) |
| #30 | The OCR worker reports queue depth and age through `ocr.worker_queue_metrics()`, owned like `ocr.claim_worker_job` (main's dedicated owner role is not ported) | 0082 (main 0075), runtime-grants.sql |
| #30 | Every OCR audit event names the source document's patient; finding a job, listing validations and listing publications are audited | — |
| #75 (PSELF-RLS) | Patient-self reads, index writes and chat history are bound to the patient's own live session; a context naming another patient or a revoked, expired or made-up session reads nothing. The session check is inline (main's nested call costs about 500 µs per row) | 0083 (main 0091 section 3) |

## Not ported, and why

- Already on this branch: #26 (0071 grants the list), #58 (0071 seeds `direct-care`).
- Does not apply: #52. This branch's record summary reads only encounters, notes and imported records.
- Needs `main`'s Phase 4 platform administration (0061–0072 on `main`), which this branch replaces with its own (0064): the rest of #18 (its control and audit repairs are ported above), #24, #25, #27, #32 7A (its OCR guards are ported above), #49, #81.
- Rewrites Identity's sign-in, refresh and sign-out on `main`'s token service: #39, #42, #50, #76. Port it as its own change with `main`'s HTTP session verifiers.
- Edits a suite in `services/ehr-api/database/tests/`, which production refuses: #48 (0080 also restates `main`'s 0077 bodies).
- Launch features and their infrastructure (#63–#98 except those above) were not part of this batch.

## Grants and the role bootstrap

0074 and 0076 grant to roles that already exist, which repairs production: a
release runs only `scripts/apply-migrations.mjs`. `runtime-grants.sql` revokes
every runtime grant before it applies its own, so it carries the same three
grants too, or a later role bootstrap, and every new installation (the
container acceptance and the CI migration rehearsal bootstrap after the
migrations), would remove them.

The production release used to refuse any change under
`services/ehr-api/database/` other than a new migration. It now also accepts a
modified `runtime-grants.sql` when the compatibility declaration lists it with
its SHA-256 next to at least one new migration
(`scripts/production_deployment_core.py`, `RUNTIME_GRANTS`). The release still
never applies that file, and its pending-migration check compares the plan with
the declared migrations only. Every other file there, database test suites
included, is still refused.

## Release recovery after the first deploy attempts

Both deploys of 568967b stopped at the approval step, before cloud credentials.
GitHub Actions was degraded, and its jobs API still showed finished jobs as
queued or in progress. The follow-up changes the release so this cannot block
it again, and so the reviewed migrations still deploy from a later commit:

- The approval step waits up to 20 minutes for every required job to show a
  conclusion. Any concluded job that is not a success still fails at once. The
  second check inside the deploy waits only 2 minutes.
- When a release's diff has no schema change but it includes the migration
  image, it carries the reviewed declaration in
  `config/production-schema-compatibility.json` forward. Migrations run only if
  production's pending set equals the declared files, by name and SHA-256, as
  printed by the migration plan. So 0073–0077 deploy from a commit after
  568967b, and a release that failed before migrating can be retried.
- Declared migration paths must be `migrations/NNNN_name.sql` with no
  subdirectories, and the plan is read only once all its lines have arrived.
