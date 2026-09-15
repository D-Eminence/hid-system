# Staging Cloudflare preparation

The account is `20c809ffe35ccb2c240d19a664dff97a`; the shared zone is
`69d385b9f6a3233a7113c525524f14fe` (`healthidentitydirectory.com`). The last
authenticated attempt returned forbidden/expired, so existing DNS records and
widgets remain **unverified**, not confirmed absent. No Cloudflare write has
been made during this checkpoint. All deployments remain held for the pending
Fargate request, including Cloudflare publication.

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

## USER INPUT REQUIRED

Use the existing Cloudflare dashboard account; no additional provider account is
needed. Restore local authorization to this account/zone, with **Zone Read,
DNS Read and Workers Routes Read** for inventory and **Turnstile Sites Read**
for this account. Add **DNS Edit** and **Turnstile Sites Write** only for the
staging setup operations. The token screen may label Turnstile as Read/Edit;
use the specific Turnstile permission rather than general Account Settings
Write. Renewing Worker OAuth alone does not add DNS/Turnstile authority.
[Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

For temporary operator access, enter the scoped token silently in your local
terminal, then run the read-only preflight:

```sh
read -rs -p 'Cloudflare staging operator token: ' CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
python3 scripts/staging-external-preflight.py --cloud-read-only
unset CLOUDFLARE_API_TOKEN
```

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
