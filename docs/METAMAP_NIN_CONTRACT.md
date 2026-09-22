# MetaMap NIN — deferred external integration

Reviewed **2026-09-11**. Provider and Client ID are confirmed by the owner. The
Client ID is retained only in ignored `release/local/staging-metamap-client.json`
(0600). No Client Secret was supplied, read, printed, committed or uploaded.
**NIN: DEFERRED / DISABLED. NOT A STAGING DEPLOYMENT OR ACCEPTANCE GATE. PRODUCTION: LOCKED.**

MetaMap NIN integration is prepared but deferred. Activation requires version-specific provider contract confirmation and authorized trial/test access.

The owner deferred this integration on 2026-09-11. Preserve all transport, signature,
configuration, secret-entry, test and documentation work. Staging uses
`HID_DEPLOYMENT_ENV=staging` and `NIN_PROVIDER_MODE=deferred`; it requires no MetaMap
Client Secret or NIN cryptographic keys. No NIN provider is contacted. NIN-based
new-patient registration/enrollment is excluded from the current acceptance scope;
[prepared staging accounts](STAGING_PATIENT_JOURNEYS.md) exercise normal recovery,
patient/provider login, records and governed care access without a NIN assurance claim.
Do not request MetaMap information for these staging tasks.

## Post-staging activation task

- Obtain MetaMap version-specific callback documentation.
- Confirm the signature verification contract.
- Confirm request correlation and replay semantics.
- Confirm date/time formats.
- Confirm authorized NIN trial/test identities.
- Confirm pricing/charges.
- Securely store the Client Secret in the designated staging secret.
- Complete the real adapter and run provider verification tests.
- Enable NIN only after all integration acceptance checks pass and activation is authorized.

The contract review and tooling instructions below are retained for that future
task. They are not current staging inputs or permission to activate NIN.

## Confirmed public contract

| Item | Official contract |
| --- | --- |
| Service | MetaMap standalone Government Checks, Nigeria NIN |
| Version | URL path `govchecks/v1`; embedded OpenAPI 3.1.0, `info.version: 1.4` |
| Operation | `POST https://api.prod.metamap.com/govchecks/v1/ng/nin` |
| Input | JSON strings `documentNumber`, `firstName`, `lastName`, `dateOfBirth`, `phone`, `callbackUrl`; schema gives no required list or date formats |
| Correlation input | Flat metadata, maximum 4 KB; HID preparation sends only a generated opaque request UUID |
| Result example | `status`, `id`, `error`, `data`; example ID `nigerian-nin-validation` identifies the check type, not a unique verification |

The [Nigeria NIN reference](https://docs.metamap.com/reference/govchecks-nigeria-nin-1)
requires a webhook. Its OpenAPI 200 example contains unquoted type placeholders
and lacks a closing brace; it is not an executable response schema. The document
does not specify a unique result reference, callback envelope or event timestamp.
Use its declared server, not its older `api.getmati.com` sample. No sandbox host
is declared. The local client omits DOB and phone until their requirements are
confirmed; this is preparation, not evidence that the reduced request is accepted.

Authentication is `POST https://api.prod.metamap.com/oauth/`, HTTP Basic with
Client ID as username and Client Secret as password, and form body
`grant_type=client_credentials`. The documented JSON fields are `access_token`
and `expiresIn` (example 3600 seconds). Subsequent requests use Bearer authorization.
HID caches a validated token in memory for at most 55 minutes, bounded by the
reported lifetime minus one minute. Credentials and tokens never become receipt
fields. The GovChecks schema's `example.com` OAuth token URL is a placeholder;
the actual [Authentication reference](https://docs.metamap.com/reference/authentication)
is authoritative for this endpoint (also OpenAPI `info.version: 1.4`).

The [API guide](https://docs.metamap.com/docs/api-guide) distinguishes standalone
GovChecks from builder verification flows. Standalone checks do not require a
configured metamap/Flow ID. HID must not infer `/v2/verifications` polling,
`flowId`, or a builder `resource` envelope for this separate product.

## Callback and result gaps

The [general webhook setup](https://docs.metamap.com/docs/configure-your-webhook-url)
documents `x-signature` as hex HMAC-SHA256 using a separately configured webhook
secret. It requires at least 16 characters including uppercase, lowercase and a
digit. Setup is described per metamap ID; selection of that secret for a
standalone `callbackUrl` is not explained. The prepared byte-signature helper
does not establish that this scheme applies to standalone NIN.

[General webhook specifications](https://docs.metamap.com/docs/webhook-specifications)
describe event names, resource links and timestamps for verification flows. A
step status 200 can still accompany an error. The
[NIN step examples](https://docs.metamap.com/docs/step-completed-n#nigerian-nin-validation)
show names, DOB, gender and NIN, plus much more personal data than HID needs;
examples use ambiguous dates such as `01-01-1990`. Neither source establishes the
standalone callback's full contract. No raw callback, portrait, next-of-kin,
religion or address is persisted by the preparation code.

For post-staging activation, the exact documentation still needed from MetaMap is an authoritative clarification
or versioned supplement to **“GovChecks: Nigeria NIN”, operation
`govchecks-nigeria-nin-1`, GovChecks v1 / OpenAPI document version 1.4**, covering:

1. Immediate HTTP response versus final callback, complete valid JSON success and
   failure schemas, unique transaction ID or guaranteed metadata echo, and event time.
2. Standalone callback authentication: how its signing secret is selected/configured,
   exact bytes signed, signature header/encoding, retries, duplicates and ordering.
3. Required fields and DOB format; exact meaning of `error`, `fieldMatches`, no-match,
   partial match and unavailable outcomes; returned NIN binding and demographic formats.
4. Supported reconciliation/idempotency, request and callback time limits, rate limits,
   and provider-approved testing for this client's Nigeria NIN entitlement.

There is no need to resend the public page or Client ID. A MetaMap support reply
explicitly tied to this operation/version is useful if no further page exists.
Keep test identities and credentials in approved secure channels, not chat.

## Account, testing and secure configuration

**Account/service:** reuse the confirmed MetaMap customer account, with standalone
Nigeria NIN enabled only after the deferred activation review. **Classification: DEFERRED for current staging; required only for future real NIN acceptance.**
This is distinct from the optional Meta WhatsApp notification account. No additional
MetaMap account creation or Flow ID is being required from the owner now.

**Environment and payment:** the [public FAQ](https://docs.metamap.com/page/faq)
says no sandbox is available and offers a sales-arranged free trial. It does not
prove this client has trial NIN access or free checks. MetaMap must confirm test
entitlement, allowed test identities and any charge before provider calls. The
documented `api.prod.metamap.com` hostname is MetaMap's service, not HID production;
it is not an authorization to submit real identities or use a paid production tenant.

**Minimum authority:** the public OAuth schema does not advertise a NIN-only scope.
Request a segregated staging/trial client restricted to Nigeria NIN where MetaMap
supports that restriction; do not claim such granularity exists. Business, NIMC
access, domain or phone verification requirements for this customer's entitlement
are not published in this contract and need provider confirmation. No extra domain,
phone or business verification is assumed complete or demanded speculatively.

**Secret location:** `/hid/staging/nin-metamap` in existing AWS account
`659225405023`, Region `eu-west-1`. This is now the designated provider-specific
location; it has not been created or populated. JSON fields are `clientId` and
`clientSecret`. It is separate from Identity's NIN encryption/HMAC keys. A future
`webhookSecret` must use the provider-confirmed standalone configuration, not the
Client Secret. Secrets Manager storage/API charges are separate [AWS costs](https://aws.amazon.com/secrets-manager/pricing/).

Only when post-staging NIN activation is authorized, the operator renews
`aws login --profile hid-admin`, then runs locally:

```sh
python3 scripts/staging-metamap-secret.py
python3 scripts/staging-metamap-secret.py --store
```

The first command reads only the private local Client ID file and reports presence.
The second is an explicit staging secret write and prompts for the Client Secret
without echo. It pins AWS endpoints/account/name, preserves other JSON fields,
refuses a different existing client, and passes secret material through an anonymous
stdin pipe to the AWS CLI. It refuses noninteractive input and never prints provider
values or upstream errors. It also refuses enabled AWS CLI history, which can
[persist full request/response data](https://docs.aws.amazon.com/cli/latest/userguide/data-protection.html).
No secret is passed in command arguments, shell history,
environment files or temporary files. Do not use shell tracing or terminal recording.

Operator IAM: `sts:GetCallerIdentity`; exact staging secret `DescribeSecret`,
`GetSecretValue`, `PutSecretValue`; `CreateSecret` and `TagResource` for this name
only if absent. AWS managed Secrets Manager encryption is used for creation; any
existing customer-managed key requires its appropriate scoped KMS permissions.
The [AWS create-secret reference](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/create-secret.html) documents creation, tagging and KMS authority.
No new administrator or static AWS credential is required. Runtime injection is
deferred: eventually only Identity's execution role receives this exact secret;
other workloads and frontend bundles must receive none of its fields.

## Prepared implementation and activation sequence

`metamap-govchecks.client.ts` implements the documented OAuth/submission transport,
requires an explicit confirmed staging configuration, pins both provider endpoints,
restricts callbacks to HID's staging API origin, refuses redirects, bounds time/body
size, redacts errors and never retries a NIN POST automatically. Its receipt means
only an HTTP JSON response was received. It cannot return `verified`, provider
demographics, or a provider verification reference. It is not registered in Nest DI.

`metamap-webhook-signature.ts` prepares the general byte-authentication primitive.
No callback route, ECS credential injection or `metamap` runtime mode is enabled.
`NIN_PROVIDER_MODE=deferred` is the explicit staging behavior; `unavailable` remains
the default for other environments. The deterministic provider remains test-only
and is rejected in staging. The existing encryption/HMAC material is retained in
Secrets Manager but is not injected into deferred staging tasks.
This avoids accepting a forged/unbound callback or a submission acknowledgment as
identity evidence while the real contract remains incomplete.

After staging, and after the provider clarification, implement the exact result mapping and minimal
durable pending/result correlation within Identity, including replay/expiry checks,
auditable idempotency and governed case continuation. Pin the staging secret/version,
then validate approved test identities, mismatches and failures. Existing cloud,
notification, trust/custody, successor admission and deployment gates still apply.
