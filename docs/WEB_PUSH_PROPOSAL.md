# Web Push for Patients: Proposal

Status: proposed, not implemented. Nothing in this document is built,
merged as code, configured or deployed. ADR-060 records the decision it
needs. Web push is not part of the launch (D17): launch notices stay in the
patient's in-app inbox, and launch OTPs stay on email and SMS.

## 1. What exists today

Browser push does not exist. The schema was prepared for it, but no code
uses that schema.

| Part | State | Evidence |
|---|---|---|
| Device store | `notification.device_registrations` exists: account, platform (`web`, `android`, `ios`), encrypted token, keyed-HMAC lookup, key version, status `active`/`revoked`/`invalid`, revocation reason. No row is ever written | `services/ehr-api/database/migrations/0028_identity_notification_migration_state.sql:134-156`, table comment at `:203-204` |
| Delivery record | `notification.delivery_attempts` allows channel `push`; nothing writes it | 0028 `:161-182` |
| Grants | Only `hid_notification_runtime` may read or write devices; every other runtime has the schema revoked | `services/ehr-api/database/runtime-grants.sql:677-680` |
| Revocation | Account deletion revokes a patient's devices; nothing else does | `0064_patient_account_deletion_lifecycle.sql:401-406` |
| Registration API | None in any service | Notification API has only `POST /notifications/otp` and `/emergency-contact-alert` (`services/notification-api/src/notification/notification.controller.ts:10-32`); Identity's patient routes have no device route |
| Push provider | `FcmPushProvider` posts generic text to FCM HTTP v1, but nothing constructs it and its access-token provider has no implementation | `services/notification-worker/src/fcm.provider.ts:3-41`; `main.ts:20` builds Novu only; the provider union is `'novu'` (`types.ts:19`) |
| Delivery path | The notification worker consumes EventBridge events through Novu and is off in production (D17) | `infra/aws/src/config.ts:78-80`, `services/notification-worker/src/repository.ts:47` |
| In-app inbox | Live at launch: access requests, emergency access and PIN use reach `notification.inbox_items` by database trigger | 0037, `0091:281-301`; `GET /identity/me/notifications` |
| Frontend | Health-id `077b85c` has no service worker, manifest, permission prompt or push code | Read-only grep of `apps/*` and `packages/*` |
| Edge | The portal CSP has `worker-src 'none'`; the artefact verifier refuses a service worker, a manifest and any `serviceWorker` reference; ADR-052 says Health-id registers no service worker | `infra/cloudflare/src/frontend-worker.mjs:70`; `infra/cloudflare/scripts/health-id-artifact.mjs:116-119, 258-259, 352-353`; release check S4l (2) |
| Decision | No decision approves a push channel; PIN-use SMS and email notices "wait for an approved notification channel" | `docs/PHASE_3_LAUNCH_DECISIONS.md` (NOTIF-PIN-NOTICE) |

So the work is a decision, an edge change, one migration, two small server
components and a frontend opt-in, not a second notification system.

## 2. Recommended transport: standard Web Push, payload-free

Two transports fit the existing `device_registrations` row. Standard Web Push
needs fewer new parts and no new data processor.

| | Standard Web Push (VAPID) | FCM web tokens |
|---|---|---|
| Browser code | Native `PushManager.subscribe`; no npm dependency | The `firebase` SDK and a Firebase messaging service worker |
| New third party | None: each browser's own push service, which receives an empty message | A Google project and service account: a new data processor to approve |
| New secret | One VAPID private key | A Google service-account key, plus VAPID under the hood |
| Server code | About 100 lines of `node:crypto` (ES256 JWT); no lockfile change | An `FcmAccessTokenProvider` (OAuth JWT exchange) and wiring `FcmPushProvider` |
| CSP `connect-src` | Unchanged | Opened to Firebase hosts |
| iOS | Only for a Home-Screen web app, which needs a manifest (ADR-052 forbids one today) | Same limitation |

Payload-free means the push carries no data at all. The service worker shows
fixed text, the same text the existing adapters use: title "HID", body "You
have a new update in HID. Sign in securely to view it." Tapping it opens the
portal inbox, which needs a signed-in session. No patient name, facility,
code, count, diagnosis, result, medication or other clinical information ever
leaves the server, so no payload encryption (RFC 8291) is needed. The
subscription's `p256dh` and `auth` keys are stored now in case a payload is
ever approved; that would need its own decision.

`FcmPushProvider` stays as the future native mobile path.

## 3. Proposed design

Identity owns subscriptions and the delivery queue, because it owns the
patient session and the inbox. The Notification API owns the transport,
because it already holds the outbound providers and their secrets. This
mirrors the emergency-contact path that is on at launch (Identity dispatcher,
then workload-authenticated Notification API). The notification worker, Novu
and FCM are not involved.

```
inbox item inserted (existing triggers)
  -> trigger: one push_deliveries row per active web registration
  -> Identity WebPushDispatcher (sweeper): claim, decrypt endpoint
  -> Notification API POST /notifications/web-push (workload JWT)
  -> browser push service (empty POST, VAPID)
  -> record outcome: delivered / retry / invalidate registration
```

### 3.1 Migration (next free number after the launch chain)

1. Add `transport text not null default 'web_push'` to
   `notification.device_registrations`, checked to `fcm` or `web_push`.
2. Replace the unconditional unique on `token_lookup_hmac` with a partial
   unique index on active rows. Re-subscribing after a revoke, or the same
   browser used by another account later, then creates a new row and keeps
   the history.
3. Create `notification.push_deliveries`: inbox item, registration, status
   `pending`/`delivered`/`failed`, attempt count (at most 8), next attempt
   time, lease owner and expiry, last safe code; unique per inbox item and
   registration.
4. An `AFTER INSERT` trigger on `notification.inbox_items` queues one
   delivery per active web registration of the account, skipping deleted
   accounts as 0066 does.
5. Security-definer commands, granted to `hid_identity_runtime` only, bound
   to `identity.patient_self_session` so a caller acts only for its own
   account; Identity keeps no direct table access, so the runtime-role
   assertion that Identity cannot read devices still holds:
   - `register_my_web_push_subscription(session, ciphertext, hmac, key_version)`:
     upsert by HMAC, refresh `last_seen_at`, at most 10 active per account
     (the oldest is revoked with `DEVICE_LIMIT`);
   - `revoke_my_web_push_subscription(session, registration_id)`:
     `PATIENT_UNSUBSCRIBED`;
   - `claim_web_push_deliveries(worker, limit, lease)`: `FOR UPDATE SKIP LOCKED`;
   - `record_web_push_delivery_outcome(...)`: retry after
     `least(3600, 2^n * 30)` seconds; on a gone endpoint, mark the
     registration `invalid` with `PUSH_ENDPOINT_GONE`; write a PHI-free
     `delivery_attempts` row (channel `push`, provider `web_push`).
6. Widen `auth.otp_rate_limits`' scope check with `push_subscription_account`,
   as 0069 and 0086 did.
7. Revoke an account's devices on recovery completion and administrative
   disable too, not only on deletion.

### 3.2 Browser API (Identity; proposed contract)

All three routes are patient-only (`@PatientOnly`), under the existing
`/api/v1/identity/` gateway prefix, so no gateway change. Mutations need the
allowed `Origin` and the CSRF header like every other patient command.

| Route | Request | Response | Errors |
|---|---|---|---|
| `GET /api/v1/identity/me/web-push` | — | `200 { "enabled": boolean, "applicationServerKey": string \| null }` (base64url VAPID public key; `null` when disabled) | `403 PATIENT_SESSION_REQUIRED` |
| `PUT /api/v1/identity/me/web-push/subscription` | `{ "endpoint": "https://…", "keys": { "p256dh": "<base64url>", "auth": "<base64url>" } }` | `200 { "registrationId": "<uuid>" }`; the same endpoint again refreshes it and returns the same id | `400 VALIDATION_FAILED`, `400 PUSH_ENDPOINT_NOT_ALLOWED`, `409 WEB_PUSH_DISABLED`, `429 PUSH_SUBSCRIPTION_RATE_LIMITED` |
| `DELETE /api/v1/identity/me/web-push/subscription/:registrationId` | — | `204` | `404 PUSH_SUBSCRIPTION_NOT_FOUND` for any id the patient does not own |

Validation: the endpoint is `https:`, port 443, at most 2048 characters, with
its host on a fixed push-service allowlist in code (for example
`fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`*.notify.windows.com`, `web.push.apple.com`; confirmed at build time).
`p256dh` decodes to 65 bytes starting `0x04`; `auth` decodes to 16 bytes.

Ownership: every command runs through the session-bound database function,
so one patient can never read, refresh or delete another's registration; an
id the caller does not own is answered `404` exactly like an unknown id.

Storage: the subscription JSON is encrypted with AES-256-GCM and AAD bound to
the row id, following `emergency-contact-protector.ts`; the lookup value is
HMAC-SHA256 over a domain label and the endpoint. Both keys are dedicated,
32 bytes, server-only, from Secrets Manager. The endpoint is a bearer
capability: it is never logged, audited or returned.

Audit: `identity.patient.web-push.register.command` and `.revoke.command`,
carrying the registration id only. Rate limit: 20 registrations per hour
per account.

### 3.3 Delivery

- **Identity `WebPushDispatcher`**, on the patient lifecycle sweeper's
  pattern, claims due deliveries, decrypts the endpoint (a key mismatch is a
  definitive failure), sends at most one push per device per run, and calls
  the Notification API with `Idempotency-Key: web-push:<deliveryId>`.
- **Notification API `POST /notifications/web-push`**, workload-authenticated
  like the existing routes, body `{ endpoint, ttlSeconds }`. It checks the
  allowlist again, signs an ES256 VAPID JWT (`aud` the endpoint origin, `exp`
  at most 12 hours, `sub` a `mailto:` contact), and POSTs with
  `Content-Length: 0`, `TTL: 86400`, `Urgency: normal`, `Topic: hid-update`,
  no redirects, and a 5-second timeout.
- **Outcomes:** `201`/`202` delivered; `404`/`410` gone, which invalidates the
  registration; another `4xx` a definitive failure that keeps the
  registration (a configuration fault); `429`, `5xx` and timeouts retried with
  backoff, honouring a capped `Retry-After`. One PHI-free outcome log line,
  like `notification.otp.outcome`, with no endpoint.
- **Stale cleanup:** a gone endpoint is invalidated at once; the sweeper
  revokes registrations unseen for 60 days (`STALE_SUBSCRIPTION`); the portal
  re-sends its subscription on load while permission is granted, which
  refreshes `last_seen_at`.

### 3.4 Configuration (all default off; no secret committed)

| Service | Setting | Notes |
|---|---|---|
| Identity | `WEB_PUSH_SUBSCRIPTIONS_ENABLED` | Default `false`; production refuses `true` until ADR-060 is accepted |
| Identity | `WEB_PUSH_VAPID_PUBLIC_KEY` | Public; served by `GET /identity/me/web-push`, so no frontend build variable |
| Identity | `NOTIFICATION_DEVICE_ENCRYPTION_KEY_B64`, `NOTIFICATION_DEVICE_LOOKUP_HMAC_KEY_B64`, `NOTIFICATION_DEVICE_KEY_VERSION` | Dedicated server-only keys, required when enabled |
| Identity | `WEB_PUSH_DISPATCH_SECONDS` | Dispatcher interval |
| Notification API | `WEB_PUSH_ENABLED` | Default `false`; production refuses `true` until accepted, as `EMERGENCY_CONTACT_DELIVERY_ENABLED` does |
| Notification API | `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_SUBJECT` | The private key is a new field of the existing notification-provider secret, injected as an ECS secret; a preflight checks both services hold the same public key |
| Edge | CSP `worker-src 'self'` on the Health-id hosts; one fixed-name push service worker allowed by the artefact verifier, served `no-cache`; S4l (2) updated | Needs the ADR-052 amendment |

The operator generates the VAPID key pair offline. Egress needs no infra
change (Identity and the Notification API already reach any HTTPS host
through NAT); the allowlist in code is the SSRF control.

### 3.5 Frontend (Health-id; after acceptance)

- One static service worker at a fixed path with only `push` and
  `notificationclick` handlers: no `fetch` handler, cache or storage. On push
  it shows the fixed text with tag `hid-update`; on click it opens the
  portal's inbox on its own origin.
- Opt-in from a button in account settings (a user gesture), never on page
  load: `GET /identity/me/web-push`, `Notification.requestPermission()`,
  `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`,
  then `PUT …/subscription` with `subscription.toJSON()`'s `endpoint` and
  `keys`.
- Turning it off, or signing out on this device: `subscription.unsubscribe()`
  and `DELETE …/subscription/:registrationId`.
- No new npm dependency.

### 3.6 Tests required with the implementation

- SQL suite, failing first: a patient registers, refreshes and revokes only
  their own registrations; another patient's id is `404`; the cap; the
  partial unique index; revocation on deletion, recovery and disable; the
  delivery trigger skips deleted accounts; claim leases; the retry schedule;
  gone endpoints invalidated; runtime-role grants (Identity still cannot read
  the table directly).
- Unit: endpoint allowlist and SSRF refusals (other host, port, scheme,
  redirect, IP literal); key length checks; VAPID JWT verified against the
  public key; response classification; the outcome log has no endpoint.
- Runtime verifier through the gateway with cookies and CSRF, against a
  stub push service.

## 4. Decisions and dependencies before implementation

1. Accept ADR-060: web push is an approved patient channel, payload-free.
2. Amend ADR-052 for one push-only service worker, and update the CSP, the
   artefact verifier and S4l together.
3. Decide whether iOS matters now; it would also need a manifest.
4. DPO review of the subscription data (the endpoint identifies a browser).
5. Take the next free migration number when the work starts. The Novu
   subscriber sync of draft D-Eminence/hid-system#8 is ported as ADR-064
   (migration 0095, number provisional); it touches the notification worker
   and Novu, not devices or push.

None of this is a launch blocker, and none of it should displace launch
work.
