# Staging provider accounts and activation requirements

Research date: **2026-09-10**. Sources below are current provider documentation and
the active adapters in this repository. This document is an account/setup guide,
not a record of account creation, payment, message delivery or staging acceptance.
No provider account was created, no person was contacted and no message was sent
during this research.

**2026-09-11 NIN update:** MetaMap is confirmed for NIN verification and is separate
from Meta WhatsApp below. **MetaMap is deferred after staging**, requires no current
credential/account action, and does not block staging. Trial entitlement and its
standalone callback contract are future activation requirements. Exact configuration, payment
uncertainty, minimum authority and secure secret entry are in
[MetaMap NIN contract review](METAMAP_NIN_CONTRACT.md). The notification
classifications below remain unchanged.

## What is required for the current staging scope

The implementation audit confirms that active patient/staff recovery sends **email
only**. The intended staging configuration therefore requires **SES for OTP,
Novu for asynchronous emergency notifications, and Turnstile for browser security
checks**. Reuse the existing AWS and Cloudflare accounts. Create a dedicated Novu
staging organization/environment only if one is not already available. **Do not
create Termii, Meta WhatsApp or Infobip accounts for this acceptance scope.**

The staging-only `NOTIFICATION_DELIVERY_PROFILE=email-only` correction now removes
unused provider startup requirements and ECS secret-field injection. Notification
API tests (31), infrastructure tests (84), typechecks and the build pass; the
production template remains byte-identical. The existing `full` production profile
is unchanged. Live staging deployment and delivery remain unverified.

| Account/service | Classification | What it proves when actually tested |
| --- | --- | --- |
| Existing AWS account, SES in `eu-west-1` | REQUIRED: primary email OTP transport | Delivered recovery email and completion using that delivered code |
| Dedicated Novu staging organization/environment | REQUIRED: implemented ordinary/emergency notification path | Outbox-to-worker-to-workflow-to-selected-channel delivery, with subscriber resolution |
| Existing Cloudflare account, staging Turnstile widget | REQUIRED: live protected browser flows | Real Siteverify acceptance and hostname/action/replay rejection |
| Termii Messaging API | OPTIONAL: SMS is outside the active acceptance journey | SMS delivery only after explicit channel activation and adapter verification |
| Meta WhatsApp Cloud API | OPTIONAL: WhatsApp is outside the active acceptance journey | Approved authentication-template delivery only after activation |
| Infobip channel APIs | FALLBACK: optional activation; disabled in current staging profile | The selected channel's fallback delivery and failure handling |

None of these five integrations is classified REDUNDANT in the full existing
implementation: each has a distinct primary-channel, orchestration or fallback role.
Only SES and Novu require notification-provider configuration for this staging scope.

An account or API key does not establish delivery. A provider's accepted/queued
response, a Novu accepted trigger, and the patient's access-history page are
different observations. Keep the selected trial/demo channel and its limitations
in acceptance evidence. Existing release and cloud-deployment gates
remain in [the staging execution record](TUF-STAGING-EXECUTION.md).

## Amazon SES: reuse AWS; verify the sender and test recipient

**Product and account.** HID uses the SES v2 `SendEmail` API through the AWS SDK,
not SMTP. The existing AWS account is sufficient; SES is configured per Region.
Use the intended `eu-west-1` account context and a staging sender controlled by the
owner. AWS's setup process verifies email/domain identities.
[AWS SES setup](https://docs.aws.amazon.com/ses/latest/dg/setting-up.html)

**Trial/payment.** SES sandbox access is sufficient for a bounded test with verified
recipients: its documented limits are 200 messages per 24 hours and one per second.
Sandbox removal is needed for unverified recipients, not merely because the HID
runtime uses `NODE_ENV=production`. A verified sender remains necessary after
sandbox removal. SES is metered; free-tier eligibility depends on the existing
account's usage/age and AWS terms. Do not assume this account has free credits or
needs a new account, paid support plan, dedicated IP, or subscription.
[Sandbox rules](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html),
[SES pricing](https://aws.amazon.com/ses/pricing/)

**Configuration and minimum runtime authority.** Set `sesFromAddress` in the existing
`/hid/staging/notification-provider` secret; CDK maps it to `SES_FROM_ADDRESS`.
`AWS_REGION` comes from deployment. The Notification API uses its ECS task IAM
identity, so no AWS access key, SMTP password or SES API key is a user input.
Its send operation needs `ses:SendEmail`; restrict it to the verified staging
identity and, for a bounded test, the approved From/recipient where the reviewed
IAM plan supports those conditions. Account setup/identity verification belongs
to the operator, not the sending task. Current source still grants the send action
on `*`; this guide does not claim narrower IAM has already been deployed.
[SES IAM controls](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html)

**Verification.** With operator authentication, inspect the selected Region's
sandbox/sending status and verified identities. For an email identity, the owner
must complete its verification email; a domain identity requires the exact
provider-generated DNS records. Verify the explicitly approved recipient while
sandboxed. Then, after deployment authorization, run the real HID recovery flow,
confirm receipt and code completion, and retain metadata-only evidence. A mailbox
simulator helps exercise transport outcomes but cannot prove human receipt of an
OTP. No verification email or test send is authorized by this document alone.

## Novu: workflow orchestration needs a subscriber and a delivery channel

**Account/payment.** Novu Cloud offers a free plan with no credit card required at
signup; the researched plan includes 10,000 workflow runs/month and two environments.
Provider delivery charges and plan limits are separate. A custom third environment
may require a different plan; a dedicated staging organization using its development
environment avoids assuming that entitlement. Preserve the approved region:
`NOVU_API_URL` defaults in this repository to `https://api.novu.co`; an EU account
uses `https://eu.api.novu.co` and needs the matching deployment configuration.
[Novu pricing](https://novu.co/pricing/),
[Environment isolation](https://docs.novu.co/platform/developer/environments),
[Regional API endpoints](https://docs.novu.co/api-reference)

**Verification.** For the bounded demo path, the actual Novu account inbox must be
the approved recipient. The reviewed demo setup specifies no business, sender-domain
or phone verification requirement; follow any email verification requested by signup.
A separately configured delivery provider imposes its own sender/domain/phone rules.
No production organization or production subscriber is part of this setup.

**Authority/configuration.** Store the selected staging environment's secret key
as `novuApiKey` in `/hid/staging/notification-provider`, mapped to `NOVU_API_KEY`.
The application needs to trigger workflows, but Novu's documented secret key has
**full administrative access** and is environment-specific; a trigger-only key
has not been established. Use a dedicated staging organization/environment,
keep the key server-side, and rotate it through the approved secret path. The
public Application Identifier is not a substitute for this key.
[Novu API keys](https://docs.novu.co/platform/developer/api-keys)

The active [event mapping](../services/notification-worker/src/event.ts) and
[orchestrator](../services/notification-worker/src/novu.orchestrator.ts) require
these exact workflow identifiers:

| Workflow identifier | Version-1 domain events |
| --- | --- |
| `patient-update-v1` | `EmergencyAccessActivated`, `LabResultReleased`, `MedicationDispensed` |
| `identity-registration-update-v1` | `PatientRegistered` |
| `identity-resolution-update-v1` | `PatientIdentityResolved`, `OutreachPatientResolved` |
| `document-update-v1` | `OcrPublicationSucceeded` |

The worker calls `POST /v1/events/trigger` with `to.subscriberId` equal to the
**canonical Identity patient UUID** and a generic sign-in message. It does not
send the patient's email, telephone number, clinical record or emergency reason.
For a test delivery, preconfigure that exact synthetic patient's subscriber with
the owner-approved test email and enable the workflow's Email step. An API key
alone cannot supply the missing contact mapping. This is a staging test mapping,
not evidence of automated production subscriber provisioning.
[Novu email delivery model](https://docs.novu.co/platform/integrations/email)

**Choose and record the delivery channel before testing:**

- **Bounded demo-email option:** Novu's built-in demo integration sends real email
  only to the address associated with the logged-in Novu account, with a documented
  300-email monthly limit. It needs no separate delivery-provider account. Use it
  only if that inbox is the explicitly approved test recipient. Record results as
  Novu demo-channel staging delivery; this does not test an SES-backed Novu
  integration or unrestricted recipients.
  [Demo integration rules](https://docs.novu.co/platform/integrations/demo-integration)
- **SES-backed option:** Novu's documented Amazon SES connector requires an AWS
  access-key ID and secret access key, SES Region, verified From address and sender
  name. It does **not** inherit HID's ECS task role, and the connector guide does
  not establish a role-federation alternative. SMTP credentials are not the
  documented credentials for that connector. Do not export an operator session or
  create static AWS keys automatically. This option needs a separately reviewed
  credential design and authorization consistent with repository security rules.
  A configuration set is optional for sending but required by Novu's documented
  SES activity-tracking setup.
  [Novu SES integration](https://docs.novu.co/platform/integrations/email/amazon-ses)

**After secure account authorization, Codex will:** inspect the environment and
region; read existing workflows/integrations before proposing changes; configure
the four required workflow IDs using only the generic message; associate the exact
synthetic patient UUID with the approved inbox; verify the Email step and selected
integration; securely bind the environment key; and, after the separate send
authorization, trace one emergency event through outbox, dispatcher, queue, worker,
Novu activity and actual inbox receipt. Record accepted, delivered and failed
outcomes separately, including duplicate/retry behavior. An accepted trigger alone
does not close the delivery check.

## Termii: optional SMS activation, no account needed now

The existing [Termii adapter](../services/notification-api/src/providers/termii.provider.ts)
uses the **Messaging API** `POST /api/sms/send` to deliver a code generated by HID;
it does not use Termii's hosted Token verification product. Account creation is
free. Use the account-specific base URL and API key from its dashboard.
[Termii developer introduction](https://developer.termii.com/)

For future SMS activation, obtain approval for the sender ID and transactional
route. Termii reviews sender requests with company, sender identifier and sample
use case; the documented alphanumeric length is 3–11 characters. OTP should use
the account-activated **`dnd` transactional route**. Current repository default
`TERMII_CHANNEL=generic` must not be taken as approved OTP configuration: Termii
documents `generic` as promotional and warns about OTP failures/blocking. No
support request was sent during this research.
[Sender registration](https://developer.termii.com/sender-id),
[Messaging routes](https://developer.termii.com/messaging-api)

Required future fields are `termiiBaseUrl`, `termiiApiKey`, `termiiSenderId`, plus
an explicitly reviewed `TERMII_CHANNEL=dnd` deployment override. Sender/route
activation and receiving a real test SMS are distinct from possessing a key.
The reviewed API documentation does not establish granular send-only API-key
scopes; request account-supported restrictions and isolate staging authority
instead of claiming a scope that has not been demonstrated.

Termii's current Signals pricing describes metered usage and destination/channel
fees, with no universal subscription/minimum for that usage. The account's actual
SMS rate card and billing arrangement must be confirmed before activation; do not
reuse older blanket prepaid-wallet or fixed minimum-top-up claims. No free SMS
allowance is assumed. This adapter does not require purchasing Termii WhatsApp,
Engage or Resolve merely to send SMS.
[Current Termii pricing](https://termii.com/pricing)

## Meta WhatsApp Cloud API: optional authentication templates

The [Meta adapter](../services/notification-api/src/providers/meta.provider.ts)
uses direct Meta-hosted Cloud API with a bearer token; it does not use the consumer
WhatsApp app or Termii's WhatsApp product. Setup needs a Meta business portfolio,
WhatsApp Business Account, business phone-number asset and an app with the relevant
access. The send permission is `whatsapp_business_messaging`; setup/template
management may need `whatsapp_business_management`. Do not request general
`business_management` solely for this send adapter. A dashboard user token is
temporary; select and rotate an appropriate system-user token for sustained use.
[Meta-maintained Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api)

Future configuration is `metaPhoneNumberId`, `metaAccessToken`,
`metaOtpTemplateName`; review the app's configured Graph version (currently
`META_GRAPH_API_VERSION=v25.0`) and template language (default `en_US`). The ID is
Meta's phone-number asset ID, not a phone-number string. The adapter sends one
code parameter in the template body and one URL-button parameter. Its approved
authentication template must match that structure; a generic `hello_world` test
does not verify this adapter contract.

For a real sender, verify control of the phone number and complete the business,
display-name, template and billing steps required by Meta for that account and
use case. Do not assume formal business verification or app review is required
for every initial test, or that approval is automatic. Meta's primary setup pages
returned HTTP 429 to this research client; their latest test-number allowances,
no-card eligibility and account-specific business-verification thresholds were
not independently confirmed. Check them in the official setup flow before
activating this optional channel.
[Meta setup entry point](https://developers.facebook.com/docs/whatsapp/getting-started/signing-up)

The current official pricing model charges by **delivered message**, with rates
depending on category and recipient market. Authentication/OTP traffic must be
budgeted using that category's current rate card; do not infer that free service
replies make OTP messages free or repeat obsolete per-conversation prices.
[WhatsApp Business Platform pricing](https://whatsappbusiness.com/products/platform-pricing/)

## Infobip: optional fallback, activate only the selected channels

The [fallback adapter](../services/notification-api/src/providers/infobip.provider.ts)
uses Email v4 (`/email/4/messages`), SMS v3 (`/sms/3/messages`) and WhatsApp template
messages (`/whatsapp/1/message/template`). It does not use Infobip's hosted 2FA
PIN lifecycle. Fallback is attempted only after a definitive primary failure;
an ambiguous timeout does not justify a duplicate send through another provider.

Signup currently requires no credit card, then email/phone verification and
company/setup details. The trial is time-limited and restricts traffic to verified
recipients and provider test senders. Adding funds transitions to a paid account;
rates depend on channel, destination and network. Confirm the actual account's
available channels, quota and sender restrictions before a test; free units do
not prove that an arbitrary authentication template or recipient is permitted.
[Account setup](https://www.infobip.com/docs/essentials/getting-started/create-an-account),
[Trial restrictions](https://www.infobip.com/docs/essentials/getting-started/free-trial),
[Paid-account activation](https://www.infobip.com/docs/essentials/getting-started/paying-account)

Use the account's base URL and a dedicated API key. Grant only the enabled send
scopes: `email:message:send`, `sms:message:send`, and/or
`whatsapp:message:send`. Broader all-channel send or administration scopes are
not necessary just to enable one fallback channel. Expiry/IP restrictions and
account/application isolation should follow the account's available controls;
do not assume CPaaS X entitlements.
[Email authorization](https://www.infobip.com/docs/email/email-over-api/send-email-over-http-api),
[SMS authorization](https://www.infobip.com/docs/tutorials/send-your-first-sms-message-using-infobip-api),
[WhatsApp authentication-template authorization](https://www.infobip.com/docs/tutorials/authenticate-users-with-whatsapp-template-messages)

Future fields in `/hid/staging/notification-provider` are `infobipBaseUrl`,
`infobipApiKey`, and the enabled channel's `infobipEmailFrom`, `infobipSmsSender`,
or `infobipWhatsAppSender` plus `infobipWhatsAppOtpTemplateId`. Despite the last
field's name, this adapter sends it as the provider's **template name**. Its
language follows `META_OTP_TEMPLATE_LANGUAGE`; review that shared setting when
enabling WhatsApp fallback.

Custom email requires a verified sender domain and its exact generated DNS
records. Custom SMS needs the destination's approved sender/number arrangement;
WhatsApp needs an approved sender and matching authentication template. Verify
delivery reports separately from queued responses. The unused adapters still
need current wire-contract tests before optional activation; this account guide
does not certify their live payloads.
[Infobip domain setup](https://www.infobip.com/docs/email/get-started-with-email/set-up-your-domain),
[SMS senders and delivery reports](https://www.infobip.com/docs/tutorials/send-your-first-sms-message-using-infobip-api),
[WhatsApp template and delivery validation](https://www.infobip.com/docs/tutorials/authenticate-users-with-whatsapp-template-messages)

## Cloudflare Turnstile: use the existing account and a staging widget

Turnstile's Free plan supports development/testing, up to 20 widgets, 10 hostnames
per widget and unlimited challenges. It can be used independently of paid
Cloudflare products. No paid plan is established as necessary for the seven HID
staging browser hostnames, subject to available widget capacity in this account.
[Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)

The account is already identified as `20c809ffe35ccb2c240d19a664dff97a`; the
September 10 discovery was forbidden for Turnstile, so existing widgets are
**unverified**, not known absent. Grant `Turnstile Sites Read` for discovery and
`Turnstile Sites Write` (dashboard `Account:Turnstile:Edit`) for authorized widget
configuration, or have the owner configure the widget. Workers OAuth alone does
not provide that authority.
[Widget management and permissions](https://developers.cloudflare.com/turnstile/get-started/widget-management/api/)

Bind only the approved staging hostnames. Put the secret in the
`turnstileSecretKey` field of `/hid/staging/identity-sensitive`, preserving its
other fields, and the public sitekey in the approved frontend build configuration.
Keep the server's exact hostname/action checks. Validate a real challenge plus
wrong-host/action, expired and duplicate-token denial through HID's server;
public test keys are useful for local tests but do not establish live acceptance.
[Siteverify validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## Information to provide through the secure setup process

For this scope, the remaining provider choices are the controlled SES From
identity and authorized test inbox; access to the dedicated Novu staging
organization/environment and its chosen delivery integration; and staging
Turnstile widget access or its public sitekey plus securely stored secret. If
using Novu demo email, the approved inbox must match the Novu account email.
No Termii, Meta or Infobip account is requested now.

Credentials belong in the stated secret systems/provider dashboards, not chat,
Git, screenshots, test fixtures or browser bundles. Codex can populate discovered
public identifiers, preserve and merge existing secret JSON fields, prepare
configuration changes, and perform the specified verification after the relevant
authentication and test-send authorization. Do not replace the secret with a
placeholder JSON object or create made-up account IDs, senders or successful
delivery receipts.

Repository references:
[Notification API configuration](../services/notification-api/src/config/environment.ts),
[provider routing](../services/notification-api/src/notification/notification.service.ts),
[Notification Worker configuration](../services/notification-worker/src/config.ts),
[AWS environment/secret bindings](../infra/aws/src/hid-regional-stack.ts).
