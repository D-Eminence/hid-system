# HID Offline-First Architecture

Cloudflare hosting changes origins, not offline authority. Each app's service
worker remains scoped to its own hostname root. Static shell assets may be
cached; `/api/` and authenticated responses must never enter Cache Storage.
OCR and Outreach Workers receive only the browser capabilities their product
requires, while Lab, Pharmacy, EHR, and Admin keep restrictive permissions.
The existing rule remains: offline pending work is not authoritative clinical,
dispensing, release, publication, identity, or administrative truth.

## 1. Purpose

HID is designed for healthcare environments in Nigeria and Africa where internet connectivity can be unreliable.

Operational applications must not assume continuous internet access.

Offline support is mandatory.

## 2. Applications

Offline support applies especially to:

* patient application
* EHR
* Lab
* Pharmacy
* Outreach

It also applies to OCR Operations and Admin as honest shell/connectivity
behavior. `offline-aware != offline-authoritative` and offline support does not
grant mutation authority.

### 2.1 Implemented application capability matrix

| App | Offline shell/status | Persisted offline mutation | Authoritative limitation |
| --- | --- | --- | --- |
| Web | Yes | No shared domain outbox | No broad patient-record caching |
| EHR | Yes | No new outbox in this checkpoint | Draft/final clinical state is not fabricated; canonical reference actions are not durable server truth |
| Lab | Yes | No | Draft/result work cannot appear verified, released, or final without Lab API acknowledgement |
| Pharmacy | Yes | No | Protected acceptance/dispensing/reversal require live Pharmacy API confirmation; pending work is not dispensed |
| OCR | Yes | No | No fake OCR execution/provider/validation/publication or raw extraction cache |
| Outreach | Yes | Yes: encrypted IndexedDB commands | Temporary identity is not canonical; reconnect reauthorizes; conflicts are explicit; acknowledged PHI is cleaned |
| Admin | Yes | No | Sensitive administration requires live Identity API authority and is never silently queued |

All seven workers are scoped to their own path (Web owns `/`) and cache only
static shell/assets. Every `/api/` request is excluded. The local desktop Chrome
acceptance confirmed exact scopes, controlled offline reloads, visible offline
status, and no API response in Cache Storage; representative devices remain a
separate external acceptance item.

## 3. Patient Offline Experience

Support where securely possible:

* PWA installation
* offline profile access
* offline emergency information
* offline viewing of approved cached records
* background synchronization

Offline login must not weaken authentication.

## 4. Hospital Offline Operations

Potential queued offline operations require an explicit domain approval,
idempotent backend contract, expected-version conflict behavior, and reconnect
reauthorization. Candidates may include:

* patient registration
* encounter creation
* prescriptions
* vitals
* clinical notes
* Lab requests
* pharmacy dispensing
* queue management

This list is not an implemented-authority list. In the current checkpoint only
Outreach registration commands are persistently queued.

## 5. Local Data

Prefer IndexedDB for structured browser-side offline data.

Sensitive data must be minimized.

Where sensitive healthcare data is stored:

* protect it
* encrypt where appropriate
* restrict lifetime
* invalidate securely
* never use plaintext local storage for PHI

### Implemented Outreach offline slice

Outreach temporary registrations use IndexedDB, not `localStorage`. Each
command payload is encrypted with AES-GCM and a non-extractable Web Crypto key
stored by the browser. The stable local command ID, `tmp_<uuid-v4>` temporary
reference, and idempotency key survive reload. The queue records individual
`pending_sync`, `syncing`, `sync_failed_retryable`, or terminal state; one
failure does not mark other commands successful. A server acknowledgement
deletes the encrypted command payload and retains only minimum receipt/mapping
metadata. Explicit sign-out clears the Outreach database.

The service worker excludes every `/api/` request and caches only the app shell
and static assets. Outreach never fabricates canonical identity while offline,
does not retry terminal authorization/validation failures forever, and presents
server conflicts rather than applying last-write-wins.

## 6. Sync Engine

Every offline mutation should become a durable queued command.

A queued command should include:

* unique command ID
* operation type
* safe payload
* local timestamp
* actor context
* facility context
* local entity identifier when required
* dependency information
* retry count
* status

## 7. Reconnection Flow

When connectivity returns:

1. authenticate or revalidate session
2. validate queued command
3. submit idempotently
4. server authorizes operation
5. server applies operation transactionally
6. audit result
7. reconcile local state
8. confirm completion

## 8. Retry

Support:

* automatic retry
* exponential backoff where appropriate
* network failure recovery
* temporary dependency failure recovery

Never retry permanently invalid clinical commands forever.

## 9. Conflict Detection

Detect:

* stale versions
* concurrent modifications
* duplicate submissions
* changed authorization
* changed facility membership
* patient identity conflicts

## 10. Conflict Resolution

Never silently overwrite medical information.

Use:

* server version numbers
* ETags
* optimistic concurrency
* explicit merge workflows
* user confirmation when needed

## 11. Idempotency

Offline commands must be safe to resend.

Use unique idempotency keys for applicable mutations.

Server-side implementations must prevent duplicate clinical creation caused by repeated synchronization.

## 12. Files

Offline document workflow:

```text
local selection
-> upload queue
-> connectivity available
-> resumable upload
-> secure object stored
-> upload confirmed
-> OCR processing
```

OCR must not begin against an incomplete object.

The port-3005 OCR API extraction does not create a new offline command model.
The EHR review UI continues to require an authenticated online request for job,
validation, patient-confirmation, and publication commands. The separately
runnable worker may process already-durable queued jobs while the EHR API is
down, but browser offline state is never treated as queued OCR truth and API
readiness does not imply worker or provider availability.

## 13. Service Worker

Use service workers for application availability.

Cache appropriate:

* application shell
* static assets
* icons
* locally hosted fonts
* safe read-only data when explicitly approved

Do not indiscriminately cache sensitive API responses.

## 14. Background Sync

Use Background Sync when browser support permits.

Do not rely exclusively on Background Sync.

The application must also support synchronization when reopened or when connectivity events occur.

## 15. Audit

Track offline lifecycle:

* queued
* attempted
* synchronized
* failed
* retried
* conflict detected
* conflict resolved

The final server audit trail must identify the original operation context.

## 16. Authentication Offline

Offline capability must not create indefinite sessions.

Handle:

* token expiration
* credential refresh
* reconnect authentication
* remote logout
* revoked access
* changed facility membership

A command queued while authorized may still require reauthorization before server persistence.

## 17. Offline Patient Registration

When registration is permitted offline:

* generate a temporary local identifier
* do not fabricate canonical HID
* synchronize to Identity
* receive canonical patient identity
* reconcile local references

If a potential existing patient is found during synchronization, require safe identity resolution rather than creating duplicates.

## 18. Testing

Test:

* loss of internet during save
* duplicate synchronization
* reconnection
* expired authentication
* conflicting edits
* two-device edits
* interrupted uploads
* slow network
* temporary API failures
* revoked facility access
* patient identity collision

## 19. Offline Success Criteria

Verify:

* app opens offline
* safe workflows remain available
* data is not lost
* duplicate submissions are prevented
* reconnect synchronization works
* conflicts are visible
* no silent overwrite occurs
* PHI is protected
* audit continuity is preserved

Permanent truth rules:

```text
saved locally != server synchronized
pending dispensing != dispensed
offline Lab draft != verified or released result
offline OCR metadata != extraction or publication success
```
