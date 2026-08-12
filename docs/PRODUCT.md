# HID Product Definition

## Production delivery model

HID retains seven independent browser products at `www`, `ehr`, `lab`,
`pharmacy`, `ocr`, `outreach`, and `admin` under
`healthidentitydirectory.com`. Cloudflare serves each product independently;
AWS remains the healthcare backend. Migrated HID 1.0 users retain their patient
UUID, HID code, profile, authorized records, and ordinary continuity-of-care
access while progressing from `LEGACY_MIGRATED` through contact and NIN
assurance. Pending stronger KYC must not create a duplicate patient or hide
historical care.

Authentication uses numeric six-digit codes—not magic links. Provider messages
contain the minimum necessary context. Ordinary notifications say that an HID
update is available and direct the user to sign in rather than disclosing
diagnoses, results, medications, NIN, or clinical text.

## Product

HID stands for Health Identity Directory.

HID is being designed as modular healthcare infrastructure that connects patient identity and healthcare records across the healthcare ecosystem.

The platform must support multiple healthcare applications while maintaining one canonical identity for each patient.

## Core Product Principle

One patient must have one canonical HID identity.

Healthcare services reference that identity rather than creating separate patient identity systems.

Identity is therefore a platform capability, not a feature belonging to EHR, Lab, Pharmacy, OCR, or Outreach.

## Primary Platform Domains

HID consists of:

* Identity
* EHR
* Laboratory Management
* Pharmacy Management
* Medical Outreach
* OCR and document digitization

Future services must be addable without major architectural redesign.

## Product Objectives

HID should enable:

* secure lifelong patient identity
* connected healthcare records
* consistent patient lookup
* facility-based healthcare operations
* consent-based access
* emergency access with auditability
* digitization of paper medical records
* secure clinical workflows
* modular deployment
* offline-capable healthcare delivery
* future healthcare interoperability

## Identity

Identity owns:

* canonical patient identity
* HID generation
* verified patient identifiers
* patient lookup
* NIN-based KYC integration
* identity resolution
* consent
* access authorization

No other service may create a competing canonical patient identity.

The authoritative backend is independently runnable as
`services/identity-api` on port 3001. EHR, Lab, Pharmacy, Outreach, OCR, and the
web application are consumers through versioned typed HTTP contracts. The
extraction does not change existing patient UUIDs or HID assignments.

Authentication identity is not patient identity. An authentication principal
may hold staff and facility roles or a governed patient relationship, but its
subject/account ID never replaces the canonical patient UUID. HID, NIN, phone,
email, MRN/external identifiers, and Outreach temporary IDs remain identifiers
or workflow references—not patient primary keys.

## NIN

NIN may be used as a verified secondary identity and KYC mechanism.

NIN must never become the internal primary key.

NIN must:

* be verified through a provider abstraction
* be uniquely associated with the correct patient
* be protected
* not appear unnecessarily in logs or responses
* be audited when used for identity operations

A verified NIN that is not yet associated with a patient starts a governed
registration and duplicate-review case. It does not automatically create a
patient or issue an HID. New identity issuance requires explicit approval after
candidate review.

HID remains the canonical application-level healthcare identifier.

## EHR

The EHR manages clinical healthcare workflows including:

* encounters
* clinical notes
* vitals
* diagnoses
* prescriptions
* document references
* clinical record workflows

The EHR references canonical Identity patient IDs.

It must not create a second patient identity database.

## Laboratory

The Lab system must operate:

* independently as a Laboratory Management System
* as an integrated service used by the EHR

EHR sends laboratory requests through the Lab API.

Laboratory results return through approved APIs or events.

Imported external laboratory evidence is a distinct Lab-owned record class. A
human-reviewed OCR transcription can preserve an external report and its
observations, but it is not evidence that HID collected a specimen, executed a
test, performed quality control, or verified a native Lab result. OCR
validates/transcribes; Lab owns the resulting laboratory evidence.

## Pharmacy

The Pharmacy system must operate:

* independently as a Pharmacy Management System
* as an integrated service used by the EHR

EHR communicates with Pharmacy through APIs.

EHR owns prescription intent. Pharmacy accepts one exact active prescription
version into its own queue and owns any later dispensing evidence. These facts
must remain distinct:

```text
prescribed != accepted != dispensed != administered
```

An operational dispense requires a separate authorized pharmacist command.
Correction appends a reasoned reversal and preserves the original event. The
current minimum Pharmacy product does not claim partial fills, refills,
substitution, payment/claims, inventory decrement, controlled-drug workflow,
or medication administration.

Human-reviewed scanned medication data may be published only as Pharmacy-owned
historical medication evidence with activity status unknown and exact OCR
provenance. It is not an active EHR prescription and is not evidence that HID
Pharmacy dispensed the medicine.

## Outreach

Outreach is an independent healthcare application designed for field operations.

It must share Identity while maintaining its own domain logic.

Offline functionality is particularly important for Outreach.

The implemented minimum product captures facility-authorized temporary field
registrations. It generates a non-patient-derived `tmp_<uuid-v4>` reference,
stores pending commands encrypted on the device, and reports “saved locally”
until the standalone Outreach API acknowledges the command. A case remains
`identity_resolution_pending` unless a separate Identity-authorized action links
an exact existing canonical patient. That link preserves both references and
does not imply that Identity created a new person.

No active product evidence justifies campaigns, public worker onboarding,
field visits, screenings, vaccinations, referrals, specimens, documents, OCR,
NIN, or EHR clinical publication in this slice. In particular:

```text
Outreach temporary identity != canonical patient identity
Offline saved != server synchronized
Identity resolved != Identity newly created
Outreach screening != EHR clinical truth until governed ingestion occurs
```

## OCR

OCR supports conversion of paper medical records into validated digital information.

Required workflow:

Paper record
-> scan or upload
-> secure object storage
-> OCR extraction
-> AI-assisted structuring
-> human validation
-> Identity resolution
-> clinical save

OCR output must not silently become an official medical record.

Human confirmation is mandatory before clinical persistence.

Validation, canonical-patient confirmation, and publication are separate.
Validated documents may remain document-only. Clinically justified note
candidates publish as draft imported EHR notes with source provenance. Scanned
Lab or medication evidence does not become a native Lab result, active
prescription, or pharmacy dispensing transaction without an owning workflow.

The OCR API is independently runnable from `services/ocr-api` on port 3005 and
owns the stable `/api/v1/ocr/*` workflow. The OCR review experience remains in
the EHR browser application. Provider execution remains a separately runnable
worker, so API availability is not a claim that Textract or a worker is ready.
This physical split changes deployment and ownership only; it adds no provider,
document class, patient-matching rule, or clinical publication target.

## Primary OCR Providers

Provider abstractions should support:

* Amazon Textract
* Amazon Bedrock

The architecture must permit additional AI/OCR providers without changing business logic.

## Frontend Strategy

HID uses a hybrid frontend architecture.

The current canonical browser applications are Web, EHR, Laboratory, Pharmacy,
OCR Operations, Outreach, and Admin under `apps/`, served at `/`, `/ehr/`,
`/lab/`, `/pharmacy/`, `/ocr/`, `/outreach/`, and `/admin/` through one origin.
Pharmacy is an API-backed operational workspace and OCR Operations complements,
but does not replace, contextual clinical OCR review in EHR.

### Next.js

Use for public and SEO-sensitive experiences including:

* landing pages
* marketing
* features
* pricing
* documentation
* blog
* knowledge base
* public hospital pages
* public patient pages
* authentication
* appointment booking
* search-engine optimized content

### React + Vite

Use for authenticated operational applications including:

* EHR
* Lab
* Pharmacy
* OCR Operations
* Outreach
* Admin
* internal dashboards
* authenticated patient dashboard

Every application is offline-aware. Only workflows with an explicit durable,
idempotent, reauthorizing command contract may mutate offline; Outreach is the
strongest offline-first surface. `Saved locally` is not a claim of server
synchronization, and no app may present final clinical/dispensing/publication
state before the owning API accepts it.

Sentry supports sanitized technical observability and PostHog supports
allowlisted non-PHI product analytics. Neither system is a clinical data store,
and replay/automatic capture are disabled for the current browser platform.

### Implemented Lab custody scope

Native operations preserve distinct work-item, accession, requirement, and
physical-specimen identities. Authorized Lab staff can accession accepted work,
record collection, receive a collected specimen, or reject it with a reason.
These are custody states only: accession is not collection and receipt is not
testing or a result.

## Operating Environment

HID must be designed for real healthcare environments in Nigeria and Africa where connectivity may be:

* slow
* intermittent
* unreliable
* unavailable for periods of time

Offline operation is therefore a core product requirement.

## Scale Goal

The architecture must be capable of evolving toward:

* millions of patients
* thousands of healthcare facilities
* multiple healthcare services
* multiple African countries

This does not require premature overengineering, but architectural choices must not create unnecessary barriers to future scale.

## Future Product Domains

The platform must allow future services such as:

* Billing
* Claims
* Radiology
* Immunization
* Telemedicine
* Inventory
* Scheduling
* Notifications
* Analytics
* Public Health Reporting

### Implemented Lab execution scope

Authorized Lab staff may start and complete execution only for a received
specimen, then enter or correct a manual result. All result history is visibly
unverified. Entry is not verification, attestation, release, or critical-result
communication.

## Governed platform administration

HID includes a dedicated desktop-first React/Vite administration application
at `/admin/`. Its first working slices are truthful overview counts, facility
lifecycle governance, principal/facility/platform membership inspection,
account/session controls, masked Identity-review evidence, immutable audit,
service readiness, and PHI-minimal event-delivery status.

This is platform governance, not clinical practice. A platform administrator
cannot edit records, enter/verify/release Lab results, prescribe or dispense,
validate OCR evidence, reconcile Outreach identities, or activate emergency
access merely because of the platform role. Duplicate review remains review,
not automatic merge. Event failure inspection remains read-only until a safe
owning dispatcher command is separately designed.
