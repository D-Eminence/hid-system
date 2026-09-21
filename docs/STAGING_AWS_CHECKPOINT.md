# AWS staging checkpoint — updated 2026-09-21

**AWS SESSION EXPIRED. STAGING NOT DEPLOYED OR ACCEPTED. PRODUCTION LOCKED.**

The September 14 renewed `hid-admin` session authenticated account `659225405023`, region
`eu-west-1`. The initial resource checks below ran between 14:02 and 14:12 UTC.
The owner subsequently submitted the **32-vCPU** Fargate request. AWS readback
at **2026-09-14 21:04 UTC** reported **`CASE_OPENED`, applied quota 6**. A September 15
read attempt failed because the browser session expired; September 21 read-only
quota and ECR checks returned the same error. The current request state
and applied capacity are unverified. No duplicate request or deployment is
permitted while pending, including empty foundations and Cloudflare publication.
This pending AWS decision requires no second user submission.

During the continuation, eight staging GitHub environments were created and their
owner-review/protected-branch/no-admin-bypass policies verified. No workflow was
run. No AWS resource, secret, DNS record, database or deployed application was
changed. No production API target was requested. NIN source/configuration remains
deferred; the Identity task is unchanged. The regional stack gained an explicit Novu
endpoint parameter; its production template remains byte-identical. Release capability
preparation and its separately tested staging build policy are recorded in the
[release installation guide](TUF_STAGING_RELEASE_INSTALLATION.md).

An offline ECR bootstrap review generator retains exactly the 11 application ECR
resources and 11 URI outputs and records the conditional same-stack expansion
requirement. Its supplied-template hash and counts are local preparation, not
verified source provenance: `reviewed_source_sha` is null and
`source_checkout_verified` is false. Synthesis from the exact approved checkout
and full-template hash comparison remain required before future execution.
It makes no AWS call and does not establish current regional-stack or repository
absence. It is not deployable while the quota request is pending.

## What the renewed session established

| Check | Actual result |
| --- | --- |
| Staging regional and release-trust stacks | Both return not-found errors; these are confirmed absence, not permission failures |
| Staging RDS, ECS and ECR | Database and cluster absent; all 11 application repositories and the signing-broker repository absent. The migration image shares the EHR repository |
| Existing bootstrap | `CDKToolkit` is complete; lookup, deployment, CloudFormation execution and both publishing roles exist |
| Deployment preview | Historical account-bound economy synthesis and `cdk diff --no-change-set --no-lookups --strict` passed; one new staging stack; the initial template had 434 resources, 54 parameters and 545,312 bytes. The later local Novu-parameter artifact had 55 parameters. These artifacts are not an approved source/template binding; regenerate from the exact approved checkout. No change set or asset upload |
| Permissions | Tested operator reads/role assumption, deployment-role CloudFormation actions and PassRole simulate as allowed. The pre-existing execution role has AdministratorAccess; no permission was added or widened |
| Certificates and S3 endpoint | Both referenced staging ACM certificates are issued and unused. The referenced AWS-managed S3 prefix list belongs to `eu-west-1` |
| Database compatibility | PostgreSQL major 16 currently selects default 16.13; `db.t4g.small`, encrypted gp3 storage is orderable in three availability zones. The selected CA matches the current `rds-ca-rsa2048-g1` thumbprint; its base64 value is 1,932 bytes |
| Secrets | Auth signing/login keys and OTP HMAC present. Turnstile absent. The notification-provider container and all ten database secret containers exist with zero versions |
| SES | Sending enabled, sandbox access, zero identities and zero verified identities |
| GitHub/AWS federation | The account's GitHub OIDC provider is absent. This is an agent provisioning task after the exact release trust plan is approved, not an ARN the user must invent |
| GitHub release branch | Approved base remains `a709e643a731b444f7cb775b2b16fe28164146a7`. The last green review source was `fe472b818caf6488d57ffb88875eec2300a4b7e9` in draft [PR #2](https://github.com/D-Eminence/hid-system/pull/2); it is unapproved and none of its workflows is on the protected branch |
| GitHub staging protections | Existing `staging` and `staging-publisher` environments retain the sole owner reviewer, protected branches and disabled administrator bypass; each has zero variables/secrets. The eight previously absent candidate/capability environments were subsequently installed with the same protections; no variables, secrets or workflow runs |

Policy simulation is bounded evidence and can differ from actual authorization;
it does not establish every resource policy, organization constraint or deployment
result. [AWS policy simulator limitations](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html).
The RDS minor version is a current observation: the existing template intentionally
specifies major 16, so check the selected minor and CA again at provisioning.
[AWS RDS version selection](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.DBVersions.html).

## Capacity and prepared acceptance settings

The last verified **Fargate On-Demand vCPU quota was 6**, quota `L-3032A538`. The existing
request `53cf4fecbdee43808970dadf399dce15KHtG3UD0` asks for 32 vCPUs and last reported
`CASE_OPENED` (AWS support processing). The earlier empty-history observation is
superseded; do not submit another request. Its CloudWatch usage query returned no datapoints;
that does not prove unused account capacity.

The offline [capacity assessor](../infra/aws/scripts/assess-staging-capacity.mjs)
binds the exact template digest to the account/region parameter plan and quota
receipt. It never reads credentials or changes resources, and never reports
deployment authorization. It counts task CPU, not container CPU, so token sidecars
are not counted twice. Tests cover source/account mismatches, missing counts,
zero-desired scaling, rollout rounding and exclusion of unrelated parameter values.

| Planned capacity | vCPUs |
| --- | ---: |
| Default economy desired tasks; three workers start at zero | 4.5 |
| Acceptance override: one task for each of the three workers | 6.5 |
| Every service at its configured scaling ceiling | 13 |
| All services replacing concurrently at those ceilings and 200% maximum | 26 |
| That conservative rollout bound plus one migration task | 26.5 |

The default initial footprint alone fits the numerical quota if no other workload
consumes it. Full acceptance with all workers active exceeds it, as does the
configured scaling ceiling. No CPU sizing, scaling policy or availability control
has been weakened. The 26.5 figure is an upper bound for simultaneous replacement,
not a claim that each rollout necessarily uses that amount. AWS defines
`maximumPercent` as a per-service task upper bound rounded down.
[ECS deployment configuration](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeploymentConfiguration.html),
[Fargate account/region quotas](https://docs.aws.amazon.com/general/latest/gr/ecs-service.html).

Prepared, ignored local artifacts:

- `release/local/staging-acceptance-parameter-plan.json`: copy of the existing
  economy plan with OCR Worker, Notification Worker and Event Dispatcher desired
  counts explicitly set to one for acceptance. All scaling ceilings remain two;
  all existing security bindings remain intact. Both plans now bind the current
  template and include the unresolved `StagingNovuApiUrl`, for 14 unresolved values.
  Running workers avoids depending on an unverified scale-from-zero path for the
  first notification/outbox/OCR test. This plan has not been applied.
- `release/local/20260914-aws-renewed/fargate-quota-request.json` is a historical
  preparation artifact for the request the owner has now submitted. **Do not execute
  it again.** The requested 32 limit covers the 26.5 staging envelope numerically;
  actual applied limit and other account usage must be checked before deployment.
- `release/local/20260914-quota-pending/github-environment-installation.json`
  records creation and readback of the eight staging approval environments. Existing
  environments were not replaced. No credentials, approval variables or runs were added.
- `release/local/20260914-quota-pending/cloudflare-preparation.json` binds the eight
  Worker configurations and nine staging DNS names; secret values and the ALB target
  remain absent. See [Cloudflare setup](STAGING_CLOUDFLARE_SETUP.md).
- `release/local/staging-notification-plan-20260914-region.json` is the validated
  non-secret provider/controlled-inbox preparation. See
  [notification setup](STAGING_NOTIFICATION_SETUP.md). It does not establish delivery.
- `release/local/20260921-staging-preparation/ecr-bootstrap-unbound.template.json`
  and `.review.json` are mode-0600, offline-only ECR bootstrap review artifacts.
  They preserve the 11 application repositories and outputs from their supplied
  template, whose source checkout is unverified; they create no release-trust/signing-broker resource and
  are not evidence of repository creation. Any later execution needs a newly
  reviewed dedicated path, verified stack/repository absence, the same stack name,
  the reviewed CloudFormation service role, real image digests, and a full change
  set whose additions match a fresh approved-source synthesis and has no ECR action.
  Earlier ECR review artifacts are superseded; a caller-supplied source SHA in an
  older local receipt is not verified source provenance.

Both the original and acceptance parameter plans are mode `0600`, under the
mode-`0700` ignored directory. The original economy counts/security values remain unchanged. Pre-Novu copies
are retained privately beside the comparison receipt. These local parameter plans
must be rebound to the exact approved-source template before execution.

Repeat the capacity review from the repository root:

```sh
node infra/aws/scripts/assess-staging-capacity.mjs \
  release/local/20260914-quota-pending/economy-assembly/Hid-staging-Regional.template.json \
  release/local/staging-acceptance-parameter-plan.json \
  release/local/20260914-quota-pending/quota-validated.json
```

## USER INPUT REQUIRED

| Exact action/input | Where and how | Blocking stage |
| --- | --- | --- |
| Renew the expired AWS browser session | Run `aws login --profile hid-admin` locally, complete AWS browser authentication, then run `python3 scripts/check-staging-fargate-quota.py` and `python3 scripts/check-staging-ecr-bootstrap.py`. No keys in chat | Current quota/capacity and exact bootstrap-absence verification; deployment remains held |
| Authorize staging DNS/Turnstile operations and the scoped publisher token | Existing Cloudflare account/zone. Renew its browser session locally if needed. Turnstile secret is a JSON field `turnstileSecretKey` in `/hid/staging/identity-sensitive`, preserving existing fields. Store publisher API token as the **raw SecretString**, not JSON, in an AWS secret named `hid-staging-cloudflare-publisher-token-*`; the publisher pins its ARN/version | Live browser/API deployment and protected publication. Real Siteverify and DNS/TLS behavior must then pass acceptance |
| Select the controlled SES sender and Novu staging environment/channel; securely configure the two fields | SES `eu-west-1` and Novu dashboards; JSON `sesFromAddress` and `novuApiKey` in `/hid/staging/notification-provider`. Retain the chosen Novu region/API URL. No new AWS account or SES API key | Notification API/Worker startup and functional staging deployment. SES identity verification, workflow/channel activation and receipt are subsequent acceptance checks |
| Confirm two distinct controlled patient/clinician inboxes and separate test-send authorizations | Edit `release/local/staging-journey-input.json` locally; set `patient_email`, `staff_email` and `controlled_test_recipients_confirmed`. Separately authorize each intended SES verification, recovery OTP and Novu test in `release/local/staging-notification-input.json`, following [notification setup](STAGING_NOTIFICATION_SETUP.md). Contact control alone does not authorize a send. No passwords, OTPs or provider keys belong in either file | Live recovery/delivery/browser acceptance; these contacts do not block an empty AWS foundation |
| Actual release custodian assignments and independently trusted public material | Existing offline/hardware custody process; public intake described in [public custody](TUF_STAGING_PUBLIC_CUSTODY.md). Keep private keys/PINs with custodians | Signed release admission, publication and the subsequent admitted staging deployment |
| Review the final successor source once its follow-up CI passes | Review [draft PR #2](https://github.com/D-Eminence/hid-system/pull/2) through GitHub's source controls. Protected execution requires a separate later concrete run approval | Protected workflow installation and subsequent admitted deployment; ordinary CI is not source approval |

Notification account requirements and minimum scopes remain in the
[provider matrix](STAGING_PROVIDER_ACCOUNTS.md): SES and Novu REQUIRED;
Termii and Meta WhatsApp OPTIONAL; Infobip FALLBACK. Do not send secrets in chat.

Draft PR #2's earlier head passed ordinary CI; the bootstrap follow-up needs its
own CI and owner review. The protected release branch has not changed. Final protected workflow bindings, OIDC/provider-role
readback, generated origin/database secrets, image digests, resource IDs, and a
concrete immutable retention/key decision remain before protected execution. They are
not values the user must fabricate. Object Lock creation remains prohibited until its
concrete resource/retention decision is separately approved. The ECR bootstrap review
does not remove any of these gates or authorize a deployment.

Read the **existing** request and applied quota without submitting anything:

```sh
python3 scripts/check-staging-fargate-quota.py
```

After that read succeeds, the following also remains read-only and confirms that
the regional stack and all eleven application repositories are still absent before
any future reviewed bootstrap path:

```sh
python3 scripts/check-staging-ecr-bootstrap.py
```

The checker pins the account, region, quota and request ID. Pending/case-opened
requests hold deployment even if the numerical limit changes. `APPROVED` with
only 6 applied does not clear the quota gate. `CASE_CLOSED` requires reviewing the
actual case outcome. Even after 32 is applied, available account capacity and all
release/provider gates remain unverified. Exit zero means reads succeeded, never
permission to deploy. [AWS request status](https://docs.aws.amazon.com/cli/latest/reference/service-quotas/get-requested-service-quota-change.html),
[applied quota](https://docs.aws.amazon.com/cli/latest/reference/service-quotas/get-service-quota.html).
The September 15 lookup-role attempt was approved for execution but failed with an
expired AWS session. It did not verify role assumption or quota state. Renew with
`aws login --profile hid-admin` before repeating AWS reads. The earlier no-change-set
diff passed with a lookup-role assumption warning and same-account fallback; this
warning is still unresolved.

The [September 15 preparation receipt](evidence/staging-acceptance/predeployment-2026-09-15.json)
records the earlier expired session, quota hold, prepared workflows and validation.
The [September 21 bootstrap review](evidence/staging-acceptance/bootstrap-hardening-2026-09-21.json)
supersedes its ECR preparation and records the current read failures, source
provenance limits, guarded output tests and unchanged NIN file hashes.
The earlier bounded [checkpoint receipt](evidence/staging-acceptance/aws-renewed-2026-09-14.json)
indexes private readback/synth/diff/capacity logs under
`release/local/20260914-aws-renewed/`. Earlier local tests and NIN deferral evidence
remain retained; no unrelated application or database test suite was repeated.
