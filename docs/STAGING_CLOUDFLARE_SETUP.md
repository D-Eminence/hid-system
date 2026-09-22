# Staging Cloudflare preparation

The account is `20c809ffe35ccb2c240d19a664dff97a`; the shared zone is
`69d385b9f6a3233a7113c525524f14fe` (`healthidentitydirectory.com`). The owner-run
diagnostic at **2026-09-22 02:41 UTC** authenticated that exact active zone/account
and completed all nine exact staging DNS reads: each returned zero records.
Turnstile, Worker Routes and all eight filtered Worker Custom Domain reads
returned **HTTP 403, Cloudflare error 10000**. Those inventories remain unverified;
they are not confirmed absent. No Cloudflare write has
been made during this checkpoint. All deployments remain held for the pending
Fargate request, including Cloudflare publication.

The earlier owner report at September 21 21:57 UTC returned `request_failed`
without HTTP details; the new diagnostic supersedes its unverified zone/DNS
status. The older agent readback used a failed Wrangler credential, which is a
different credential source. A token entered in a separate terminal is not
inherited by an existing agent session; clearing it after a command also prevents
later reuse. AWS authentication is renewed, but Cloudflare authority is
independent. The staging Turnstile secret field is confirmed absent in AWS.

Generate the source-bound, non-secret plan without credentials:

```sh
node infra/cloudflare/scripts/prepare-staging-readiness.mjs
```

The plan validates the seven existing named staging Worker configurations and
the staging TUF repository configuration, recording their source hashes. Its
tests also compare the widget action list with the existing Identity validator.
It rejects production hostnames, unexpected API origins and default routes.

The seven application hosts are `staging`, `ehr.staging`, `lab.staging`,
`pharmacy.staging`, `ocr.staging`, `outreach.staging` and `admin.staging` under
the zone. `updates.staging` belongs to the protected TUF publisher. These eight
hosts use Worker **Custom Domains**: Cloudflare creates their DNS records and
certificates at deployment. Do not precreate CNAMEs for them; an existing CNAME
conflicts with Custom Domain installation. Inspect existing records first.
[Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Worker route counts do not establish Custom Domain bindings. The offline plan
now includes eight separate `GET /accounts/{account_id}/workers/domains` reads,
each filtered to one exact staging hostname and the fixed zone. After authorized
inventory, compare each returned hostname, zone and service with its expected
named staging Worker before considering a change. This API needs **Workers
Scripts Read** for the account; Zone Workers Routes Read alone is insufficient.
The September 22 Custom Domain reads were denied; no binding is yet verified.
[Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/).

Only `api.staging.healthidentitydirectory.com` needs the AWS origin target.
Its CNAME target remains null until the actual staging ALB exists and is read
back. Confirm the API DNS proxy/TLS setting against the WAF/origin controls
before completing that record. No fake ALB name, wildcard, apex change or
nameserver cutover is part of this plan. DNS ownership or shared-zone changes
are not inferred from permission to prepare staging.

The proposed widget body uses `mode: managed`, name `HID staging`, and the seven
application hostnames. Inspect widgets first and reuse a matching staging widget
where appropriate. The existing server already verifies the exact staging
hostname/action and fails closed; no application auth change is needed. The
actual site key belongs in `VITE_TURNSTILE_SITE_KEY`. Merge its secret into
`/hid/staging/identity-sensitive` as `turnstileSecretKey`, preserving the existing
OTP key. The origin authentication value is separate: generate it independently
for staging and bind the same value to the seven staging Worker
`ORIGIN_AUTH_TOKEN` secrets and the `StagingCloudflareOriginSecret` WAF parameter.
Neither secret belongs in frontend code or the plan.
[Cloudflare widget API](https://developers.cloudflare.com/turnstile/get-started/widget-management/api/).

After the actual staging widget is available, use the
[hidden staging entry helper](STAGING_PROVIDER_SECRET_ENTRY.md) with
`--field turnstileSecretKey --apply` to add its secret while preserving existing
identity fields. This does not publish a Worker or configure DNS.

## USER INPUT REQUIRED

Use the existing Cloudflare dashboard account; no additional provider account is
needed. Restore local authorization to this account/zone, with **DNS Read and
Workers Routes Read** for inventory, plus **Workers Scripts Read**
and **Turnstile Sites Read**
for this account. The zone-read API also accepts DNS Read; an additional Zone Read
permission is not required for that request. Add **DNS Edit** and **Turnstile Sites Write** only for the
staging setup operations. The token screen may label Turnstile as Read/Edit;
use the specific Turnstile permission rather than general Account Settings
Write. Renewing Worker OAuth alone does not add DNS/Turnstile authority.
[Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

**Current correction:** retain the working DNS access and grant the operator
token **Account → Workers Scripts → Read**, **Account → Turnstile → Read**
(`Turnstile Sites Read`) for the exact account above, and **Zone → Workers Routes
→ Read** for this exact zone. The September 22 run was denied at all three API
groups. If the token already lists these permissions, confirm their account/zone
resource scope and the issuing user's membership with the Cloudflare account
owner. A successful zone read alone does not prove these permissions.

The **02:45 UTC** scoped rerun produced the same denials. The owner confirmed
that only the command had been rerun; the dashboard permission change is still
outstanding. Open **My Profile → API Tokens → Edit** for the operator token and
save the permission/resource-scope changes before running it again. Use a
user-owned token for this combined inventory: Cloudflare's current compatibility
matrix lists Turnstile as unsupported by account-owned tokens. A token from
**Manage Account → Account API Tokens** therefore cannot be assumed to support
the Turnstile read even after its permission policy changes. The protected
publisher remains a separate credential and does not require Turnstile access.
[Account-owned token compatibility](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).

For temporary operator access, run the diagnostic in your local terminal. It
prompts with echo disabled and saves a new metadata-only report that the agent
can inspect; it does not persist the token. Enter just the token value, without
an `Authorization:` header, a `Bearer` prefix or surrounding quotes. Do not
recreate a token solely because the older preflight returned `request_failed`.

```sh
python3 scripts/check-staging-cloudflare-access.py --prompt-token \
  --output release/local/cloudflare-access-diagnostic-scoped-v2.json
```

Use a new output filename if that report already exists. The diagnostic makes
only fixed staging inventory GET requests and follows no redirects. It records
HTTP status and numeric Cloudflare error codes, omitting raw provider messages,
response bodies, token values and widget credentials. It stops before inventory
if the zone/account binding cannot be verified. Successful inventory reads still
do not prove write permissions, publisher authorization, browser acceptance or
deployment readiness. The original cross-provider preflight remains available
and unchanged. See [Cloudflare API troubleshooting](https://developers.cloudflare.com/fundamentals/api/troubleshooting/)
and the [zone read contract](https://developers.cloudflare.com/api/resources/zones/methods/get/).

The protected publisher needs a **separate API token** with Account Workers
Scripts Edit and this Zone Workers Routes Edit. Store it through AWS Secrets
Manager in `eu-west-1` as the **raw plaintext SecretString**, not a JSON object,
under `hid-staging-cloudflare-publisher-token-*`. The operator derives the exact
ARN/version after entry and pins them in the release configuration. Do not
send tokens, widget secrets or OTPs in chat. Account/zone scopes can reach other
resources in the same account/zone; staging isolation also depends on the
existing protected tooling enforcing exact staging worker names.

These inputs block live browser setup and protected publication. Actual browser
Siteverify, hostname/action/replay rejection, DNS/TLS, proxy and direct-origin
denial remain acceptance checks after authorized deployment. NIN is deferred
and supplies no prerequisite for any of these steps.

## September 15 CI toolchain correction

The first review-branch CI run found the pinned Wrangler dependency tree affected
by [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
Wrangler is now pinned to `4.131.2`, with its required compatible Workers types
`5.20260911.1`; its dependency tree uses patched `sharp` `0.35.4`. Registry
integrities and the installed schema/CLI hashes remain explicitly checked.
No forced peer resolution, audit exclusion or production configuration change was used.

The updated package passes the audit with zero vulnerabilities, all 55 Cloudflare
tests, all 78 release tests, schema/config verification and seven actual staging
Worker dry runs. Those dry runs do not publish Workers, modify DNS or prove live
Turnstile acceptance. The first CI failure is retained in private evidence.
The release-test CI job now installs the shared Cloudflare validator's locked
dependencies before importing it; no test or gate is skipped.
