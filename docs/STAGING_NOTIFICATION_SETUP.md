# Prepared staging notification configuration

The offline planner reads non-secret configuration and the existing controlled
journey input. It makes no provider calls, sends no mail and never authorizes
deployment. SES and Novu are required; Termii/Meta WhatsApp are optional and
Infobip is a fallback. Account costs, minimum authority and verification rules
are in [the provider account guide](STAGING_PROVIDER_ACCOUNTS.md).

`release/local/staging-notification-input.json` is a private copy of the
[input template](../release/config/staging-notification-input.template.json).
Fill in the controlled sender, actual Novu staging organization/environment and
region (`us` or `eu`), and selected Email integration (`demo-email` or `amazon-ses`).
The operator can discover organization/environment IDs after secure access; they
are not credentials or values to invent. Confirm that this is an isolated staging
environment. Do not select a production organization/environment.

Use the existing `release/local/staging-journey-input.json` for the two distinct
patient/clinician inboxes. Contact control and message authorization are separate:
the notification input has individual booleans for SES verification emails,
recovery OTP emails and the bounded Novu patient-notification test. Leave each
false until that action is authorized. Setting a boolean does not send anything.

Novu demo email requires the selected patient inbox to equal the actual Novu
account inbox. An SES-backed Novu integration requires a separately approved
connector credential design; it cannot inherit HID's ECS IAM role. The HID SES
adapter itself uses ECS IAM and needs no static AWS key.

Run from the repository root, using a new output name each time:

```sh
node scripts/prepare-staging-notifications.mjs \
  "$PWD/release/local/staging-notification-input.json" \
  "$PWD/release/local/staging-journey-input.json" \
  "$PWD/release/local/staging-notification-plan-review.json"
```

Inputs and output must be owned by the current user, mode `0600`, directly under
the real ignored `release/local` directory (mode `0700`). The command refuses
unknown fields, duplicate JSON keys, different account/region, invalid contacts,
demo recipient mismatch, symlinks and output replacement. Its terminal summary
contains only missing-input codes and a plan digest; addresses stay in the
private plan. Empty fields remain unresolved rather than acquiring test values.

In AWS Secrets Manager, region `eu-west-1`, merge **`sesFromAddress` and
`novuApiKey`** into `/hid/staging/notification-provider`, preserving existing
fields. Obtain the key from the actual isolated Novu staging environment. Never
put API keys into these JSON inputs, source, shell arguments or chat. SES sending
identity and sandbox recipients must be verified before sends. An empty Secrets
Manager container is not configured delivery.

The renewed September 21 inventory confirms this notification container exists
with zero versions, and SES has zero identities. Sender, Novu environment/region/
channel and both test inboxes remain unselected; all send authorizations are
false. Use the [hidden staging entry helper](STAGING_PROVIDER_SECRET_ENTRY.md)
to add the actual `sesFromAddress` and `novuApiKey` securely after selecting them.
Its default mode only inspects; writing a field neither verifies an SES identity
nor authorizes a message.

The plan lists the four exact runtime workflow IDs and their generic message.
The subscriber UUID remains null until the accepted synthetic journey manifest
exists; then use `manifest.ids.patient`, never `ids.account`. Inspect existing
Novu workflows and the selected integration before modifying anything. Apply the
chosen `NOVU_API_URL` using the staging-only CloudFormation parameter
`StagingNovuApiUrl`. It accepts the two documented US/EU endpoints and has no
default: region selection must be confirmed before deployment. Production
configuration is unchanged.

The current quota hold applies to every deployment. After it clears and all
release/provider gates pass, verify normal OTP recovery, emergency event delivery,
inbox receipt and retry/duplicate behavior separately. Queued or accepted events
alone do not prove delivery. NIN remains deferred and has no secret requirement
for this path.
