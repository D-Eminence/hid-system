# Phase 3 Patient Safety and Account Lifecycle Audit

Branch: `phase-3-patient-safety-audit`
Base: `phase-2-provider-reconciliation`

## Existing capabilities

### Patient self-service
- Active patient session binding to the canonical patient.
- Self authorization and session validation.
- Patient profile retrieval.
- Patient access history.
- Patient clinical record read authorization.
- Patient access PIN status.
- Account and patient lifecycle checks already participate in self-service authorization.

### Break-glass safety
- Emergency purpose-of-use is required.
- Staff membership and facility permission are revalidated.
- Break-glass duration is bounded to 5 to 240 minutes.
- A non-empty emergency reason is required.
- Activation is rate limited.
- Replay of an active grant does not create a second grant.
- Audit, grant creation, and notification intent are atomic.
- Emergency notification payload is minimum necessary and excludes clinical content.
- Durable patient notification inbox exists.
- Notification worker validates the emergency event contract and routes it through the established notification workflow.

## Missing capabilities

### P0: Patient account deletion lifecycle
The authoritative backend does not currently expose a patient self-service deletion lifecycle covering:
1. authenticated deletion initiation;
2. fresh reauthentication / proof of control;
3. deletion verification challenge;
4. policy checks for clinical/legal retention;
5. durable deletion state and idempotency;
6. revocation of active patient sessions;
7. controlled removal or irreversible de-identification of account-identifying data;
8. preservation of legally required clinical/audit evidence;
9. completion receipt and audit trail.

This must not be implemented as a blind cascade delete. Clinical records, audit records, consent history, emergency access evidence, and regulatory retention obligations require explicit retention/de-identification rules.

### P1: Emergency contact notification
The current emergency notification path notifies the patient account through the HID notification workflow. There is no authoritative patient emergency-contact model or verified emergency-contact channel that can receive a break-glass alert.

Required future capability:
- patient-managed emergency contact identity;
- verified contact channel;
- explicit consent / purpose and lifecycle;
- minimum-necessary emergency notification;
- delivery idempotency and retry;
- no clinical record content in the message;
- audit of notification intent and outcome;
- safe behavior when no verified emergency contact exists.

## Phase 3 implementation boundary

Implement account deletion as a governed lifecycle, not direct physical deletion.

Implement emergency-contact notification as a separate recipient capability. Do not repurpose the patient's own notification subscriber or expose emergency contact data through provider APIs.

No production database, deployment, DNS, or live Supabase changes are part of this audit.
