# Staging external preflight

This is preparation for external acceptance gates. It cannot sign, provision,
send notifications, migrate, deploy, or authorize a release. Production remains
locked. The current ordered input list is in
[the staging execution report](TUF-STAGING-EXECUTION.md).

## Repeatable checks with existing access

From the repository root, run the local, value-free inventory:

```sh
python3 scripts/staging-external-preflight.py
```

For fixed staging read-only AWS/Cloudflare checks using credentials already
configured securely on this machine:

```sh
python3 scripts/staging-external-preflight.py --cloud-read-only --output release/local/external-preflight.json
```

The output file must not already exist; choose a new receipt filename on later
runs. Exit zero means the receipt was collected, not that every check passed.
Inspect each status and field-presence boolean. Every receipt explicitly states
`deployment_authorized: false` and `staging_accepted: false`. Presence is not a
provider credential validity or delivery check. No secret values, raw API error
bodies, contacts, DNS contents or widget keys are serialized.

The AWS profile is the existing `hid-admin`, with fixed account `659225405023`
and region `eu-west-1`. A different STS account stops all subsequent AWS reads.
Only the three existing `/hid/staging/auth`, `/hid/staging/identity-sensitive`
and `/hid/staging/notification-provider` secret names are read, plus SES account
status. No production secret or resource is requested. Optional Termii, Meta and
Infobip fields are not required by this email-only staging check.

The Cloudflare account/zone are pinned to `20c809ffe35ccb2c240d19a664dff97a` /
`69d385b9f6a3233a7113c525524f14fe`. Zone/account mismatch stops further reads.
Only GET requests are used; HTTP redirects are refused. DNS queries name the
nine staging hosts explicitly. The shared-zone route and account-widget lists
are reduced to counts/status, never returned as raw configuration or secrets.
The script uses an existing secure `CLOUDFLARE_API_TOKEN` environment value if
present, otherwise the existing Wrangler OAuth token. It never reads `.env.local`
into the process, creates an API token, initiates a browser login, or asks for a
secret. The AWS CLI may refresh credentials within an existing authorized session.

Renew an expired AWS browser session with `aws login --profile hid-admin`, then
complete its local browser step. Renew the existing Wrangler browser session
through its configured login mechanism; adding DNS/Turnstile scopes or creating
the separately pinned publisher token is a distinct external authorization.
Existing Worker OAuth is not represented as a publisher API-token secret.

Tests cover cross-account/zone refusal and secret-value exclusion:

```sh
python3 -m unittest discover -s scripts/tests -p test_staging_external_preflight.py -v
```

## NIN contract intake — deferred after staging

[The intake template](../release/config/staging-nin-contract.template.json) now
records confirmed MetaMap GovChecks v1 / OpenAPI document 1.4, the documented NIN
and OAuth endpoints, and the remaining standalone callback gaps. The supplied
Client ID is already in private local configuration; do not request it again.
[The MetaMap contract review](METAMAP_NIN_CONTRACT.md) identifies the exact
provider clarification needed, prepared transport/signature code and local secret
entry tool for post-staging activation. Staging uses explicit deferred mode; NIN
is excluded from deployment/acceptance gates and requires no Client Secret. The
preflight does not read the MetaMap secret or require NIN HMAC/encryption fields.
Existing NIN material remains preserved. An HTTP acknowledgment is not identity verification.

Do not put API keys, tokens, raw NINs or identity documents into the intake. A
staging secret reference identifies secure storage; its value is not an intake
field. The designated location is `/hid/staging/nin-metamap`; no secret has been
created or populated. MetaMap trial entitlement, NIN charges and any account
verification requirements are post-staging work. No MetaMap account, contract,
credential or other NIN input is requested for current staging.

## Delivery and final deployment preparation

Use [the provider account matrix](STAGING_PROVIDER_ACCOUNTS.md) before creating
any notification account. Staging email OTP requires SES; the implemented
emergency notification worker requires Novu plus an approved workflow/channel
and canonical subscriber/contact mapping. Termii and Meta are optional channels;
Infobip is an optional fallback. UI grant history is not delivery evidence.

After provider authorization, Codex checks field presence, SES verification and
sandbox restrictions, Novu workflows/subscriber mapping and channel configuration
before a send. A send requires an explicitly approved test recipient. Record
provider acceptance and actual receipt separately, then exercise delivery
failure, expiration, retry and replay behavior without logging OTPs or keys.

Final stack deployment still requires the actual admitted successor, signed
trust material, exact artifact digests, secure origin/database configuration,
provider checks and protected owner approval. This preflight neither changes
those requirements nor creates an alternative deployment path. After inputs are
confirmed, Codex refreshes the staging synth/diff and runs the existing guarded
deployment and 32-migration/restore/functional acceptance procedures.
