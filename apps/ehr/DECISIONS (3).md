# HID - Architecture & Governance Decisions

> **Superseded historical record.** This file preserves EHR design and governance
> discussion from 2026-05-28. It is not current platform authority and must not
> override [`../CODEX.md`](../CODEX.md),
> [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), or the other authoritative
> documents indexed by [`../docs/README.md`](../docs/README.md). Statements below
> about source roots, backends, consent behavior, or documents "winning" are
> historical context only.

**Status:** Superseded historical decision record.
**Last updated:** 2026-05-28
**Audience:** All three engineers on HID, plus any future contributor (human or AI).

---

## How to use this document

This file records decisions that were **not obvious from the spec documents** at
the time. The rules below are retained verbatim as historical evidence and are
not active instructions.

Rules of the road:

1. **When a spec doc and this file disagree, this file wins.** The spec docs
   describe the naive flow (e.g. "type an HID number, see the patient's
   prescriptions"). Several of those flows are unsafe and have been corrected
   here. Build from this file.
2. **Every PR should be consistent with this document.** If a PR needs to
   contradict a decision here, that's a conversation for the whole team first  - 
   update this file in the same PR, don't quietly diverge.
3. **If something isn't decided here, it isn't decided.** Don't invent it solo.
   Add it to "Open questions" and raise it.

---

## 0. What HID is - and is not

HID is a **healthcare identity + clinical coordination network**. It is a
**system of record and coordination**, not a financial intermediary and not an
authorizing authority.

HID **is**:
- one identity per patient (the HID number is canonical)
- an audited, consent-governed gateway to a patient's records
- operational tooling for licensed institutions (hospital / lab / pharmacy)
- a coordination layer: a prescription created in a hospital can be fulfilled
  at a pharmacy; a lab order can be tracked end to end

HID **is not**:
- a payment processor or a holder/mover of money (see §5)
- the authorizer of clinical or pharmacy decisions - licensed professionals
  carry that responsibility; HID *records* what they did (see §4)
- a single app - it is paired institution-facing and patient-facing surfaces
  that are two sides of the same transactions

> Note: the monetization / billing layer described in earlier spec docs has been
> **removed**. There are no transaction fees, no billing events, no revenue
> tracking. Operational counts (tests processed, prescriptions fulfilled, sales
> made) remain as workflow metrics - they are not money.

---

## 1. The governance spine - the consent gate

This is the most important decision in the system. **Everything routes through it.**

There is **one consent gate** with **two sanctioned doors**:

### Door 1 - Consent (the normal path)
The patient authorizes a disclosure, producing a grant that is **scoped,
time-bound, audited, and auto-expiring**. This is how *every* node type
(hospital, clinic, consultant, pharmacy, lab) gets in when the patient is
present and able to consent.

This already exists in the backend as the `access-request-create` →
`access-request-approve` / `access-request-deny` → scoped-grant flow. The UI to
drive it does **not** exist yet - see §12.

### Door 2 - Break-glass (the emergency path)
For when the patient **cannot** consent (unconscious, incapacitated). This is
**not a bypass of the gate - it is the gate's second door**, where the consent
step is replaced by **accountability after the fact**. See §3.

### The unifying insight
The patient-consent gate is the **single front door** for hospitals, pharmacies,
and labs. We build it once and reuse it three ways. This is why the patient
approval/denial UI is the keystone of the whole platform, not just one feature.

---

## 2. Consent by action - the core privacy rule

**A patient's identity and records are never resolved by an institution typing
an identifier cold.** Identity attaches only when the patient *acts*.

A NIN or HID number is **not a secret and not consent** - it's an identifier that
can be read off a card. Treating "they typed my number" as authorization is the
central privacy hole we are designing out.

A patient "acts" - and thereby consents - in one of these ways:
- **Approves a request** (taps approve in-app, enters their access PIN at the
  counter, or presents a QR they control)
- **Presents a prescription** (handing over an HID prescription/QR *is* the
  consent for that specific prescription - lightweight, low-friction)
- **Opts in at point of sale** (chooses "yes, add this to my health record")

Consequences for specific screens (these **override** the spec docs):
- Pharmacy "patient lookup" does **not** surface a patient's data on a bare
  HID/phone entry. It *initiates* a request; the card stays blank until the
  patient acts.
- Lab "type NIN/HID to see tests" does **not** immediately reveal orders. Same
  gate.
- The only data a pharmacy ever sees about a presented prescription is the
  **per-prescription, per-line-item dispensing status** (e.g. item already
  `dispensed` elsewhere → don't double-dispense). This is **not** a browsable
  cross-prescription drug history. Narrow and purpose-bound by design.

---

## 3. Break-glass - the second door (clinical-only)

Break-glass exists for genuine emergencies where consent is impossible. Backend
spine already exists (`break-glass/index.ts` - contract to be confirmed before
extending; see §9).

**Who may break glass:** clinical nodes **only** - hospital, clinic, consultant  - 
initiated by identified clinical staff. **Pharmacy and lab never break glass.**
A commercial action with a conscious patient present is a consent-door action,
full stop.

**The four-part contract (mandatory, non-negotiable):**
1. Requires a stated **reason**
2. **Notifies the patient**
3. **Auto-expires**
4. Remains **admin-reviewable**

**Audit depth:** because the data surface now includes medication history,
allergies, and lab results, the audit must record **what was actually viewed**
under a break-glass grant - not merely that glass was broken. The after-the-fact
review is the entire accountability mechanism; it has to be meaningful.

**What it exposes:** emergency-relevant data (allergies, medications, recent
labs), pulled by the *clinician* into the clinical context. A pharmacy or lab
node never reaches into a patient's record via break-glass.

---

## 4. Node model & institutional posture

Each institution is a **HID Node**. Types: HOSPITAL, CLINIC, CONSULTANT,
PHARMACY, LABORATORY, OUTREACH UNIT.

**Pharmacies (and labs) are tooling-only.** HID **records** what a licensed
professional did; it never **authorizes** the act. Professional judgment and
legal responsibility stay with the licensed institution and the licensed
individual. This posture is what keeps HID out of regulated pharmacy/clinical
*practice* - protect it deliberately.

Requirements that follow from this posture:
- **Node onboarding captures licence details** (e.g. pharmacy premises licence,
  lab accreditation).
- **Every clinically/legally significant action ties to an identified, licensed
  staff member.** For controlled-drug dispensing the audit must answer "*which
  registered pharmacist dispensed this, when*." An unattributable log defeats
  the posture.
- **Controlled-drug handling is a recording-and-visibility concern**, not
  authorization logic we own.

---

## 5. Financial posture - HID does not handle money

**HID does not process, hold, or move money.** This is a hard line, and it is a
large part of what keeps the regulatory surface small (no PCI-DSS scope, no
CBN payment-licensing question).

- Patient ↔ pharmacy payment happens **outside HID**, through whatever the
  pharmacy already uses (cash, their own terminal). The POS "confirm payment"
  step means **record that payment occurred** (method, marked paid) - never
  process it.
- There is **no HID billing layer** (removed with monetization). If institutional
  billing is ever reintroduced, it must be a **separate ledger** from any
  patient-payment record, and it re-opens regulatory questions - treat it as a
  new decision, not an extension.

---

## 6. Pharmacy POS - one transaction, three resolutions

A pharmacy POS **must work like a normal pharmacy first.** Requiring an HID
number for every sale would make it useless in a real shop.

One transaction model, with an `origin` and a resolution:

| Resolution | When | Patient linkage |
|---|---|---|
| `walk_in` (unlinked) | **Default / common case.** Someone buys paracetamol; pharmacist rings it up. | **None.** Inventory decrements, receipt prints, sale is fully pharmacy-local. Never touches a patient record. |
| `walk_in` (linked) | Pharmacist offers "add this to your HID health record?" and the patient **opts in**. | The opt-in *is* the consent. Sale links to the patient and lands on their timeline. |
| `fulfillment` | Patient **presents an HID prescription** to fill. | Presenting the prescription *is* the consent. Resolves to the patient; marks line items `dispensed`. |

Rules:
- The receipt and inventory always belong to the **pharmacy**.
- Patient identity attaches **only** via opt-in or presented prescription  - 
  never a cold lookup (see §2).
- The prescription link on a sale is **required** for `fulfillment`, **absent**
  for `walk_in`.

---

## 7. Identity

- **HID number is the canonical internal key.** It is ours, safe to pass around
  internally, and the join key for everything.
- **NIN is an *alternate* lookup only.** It is sensitive PII (NIMC-governed,
  sensitive under the NDPA). It must be verified through proper NIMC channels,
  stored **tokenized/hashed**, and must **never unlock records on its own**.
- **One identity per patient - no duplicate patient identity systems.**

---

## 8. Lab access flow

- Hospital creates a lab order → lab receives it → accept/reject → sample
  tracking → result upload → result delivered to the patient timeline.
- A lab seeing a patient's orders by HID/NIN is **consent-gated** (§2): the lab
  *initiates*, the patient *approves*, then scoped + time-bound + audited access.
- **AI lab-result interpretation is treated as regulated until proven
  otherwise** (see §11). Build it read-only, never altering source results, with
  clear "confirm with your clinician" framing - and do **not** ship it without
  the review flagged in §11.

---

## 9. Existing architecture we extend (and must not break)

Confirmed by reading the repo (`retired_identity_backend/functions/_shared/*`, a representative
handler):

**The handler pattern (follow it for every new endpoint):**
> A thin Edge Function validates identity (`requireUser` / `requireRole`), then
> delegates the security-critical work - **audit, scope, grant issuance,
> expiry** - to a **Postgres RPC** that runs under RLS. Security-critical logic
> lives in SQL, not in the handler.

Examples to copy: `access-request-create/index.ts` delegates to
`hid_create_access_request` / `hid_access_patient_with_pin`. Error sanitation is
centralized in `_shared/http.ts` (`withErrorHandling`, `HttpError`) - **use it**;
do not hand-roll error responses or you risk leaking SQL/JWT internals.

> Historical HID 1.0 decision snapshot only. It is not authoritative for the
> current deployment or runtime architecture.

**Historical "do not" list:**
- Don't replace retired hosted identity backend auth or RLS.
- Don't introduce Redux / Zustand / MobX. State stays: `useState`/`useEffect`,
  retired hosted identity backend session, realtime listeners, helper libs.
- Don't redesign routing. Adding sibling route-trees (`/lab/*`, `/pharmacy/*`)
  in the existing idiom is fine; rewriting the router is not.
- Don't introduce parallel APIs, bypass audit logging, bypass scope/role/expiry
  validation, hard-delete medical data, or expose raw storage paths.
- New endpoints follow the thin-handler-→-RPC pattern; new tables get RLS from
  the first migration.

**Migrations:** additive-first, timestamped `YYYYMMDDHHMMSS_description.sql`,
preserve audit history, include rollback thinking.

---

## 10. Repo reality check (read this before you build)

Things in the actual repo that the spec docs don't mention - so nobody builds
against the wrong thing:

- **There are three app roots.** `/src` is **canonical** (it's what root `vite`
  builds and what `vercel.json` deploys). `/client` is an **older, flat-pages
  app** (separate package, port 3001) - legacy. `/server` is an **Express
  legacy-compatibility server** that refuses to boot in production without a
  flag and queries old non-`hid_` tables - legacy. **Build only in `/src` and
  `retired_identity_backend/`** unless we explicitly decide to clean up the legacy roots.
- **Terminology has drifted.** The standard is Staff / Clinical, but the code
  still uses "Doctor" heavily (`pages/doctor/`, `DoctorAuth`, etc.). Don't add
  *new* "Doctor"-named files; prefer the Staff/Clinical vocabulary going forward.
  The hospital portal is a rename/extend of the existing `/doctor/*` tree;
  **lab and pharmacy portals are net-new surfaces.**
- **Schema-governance smell:** there is a `retired_identity_backend/fix-schema.sql` and a
  `PRODUCTION_REPAIR.md` alongside the clean timestamped migrations. That
  suggests at least one out-of-band repair happened *outside* the migration
  chain. **Confirm what live prod schema actually is before depending on
  migration-only assumptions.**

---

## 11. Regulatory & compliance - OPEN, needs professional review

**None of this is legal advice, and none of it is settled by us.** These are
flagged so the team makes the calls deliberately and gets qualified review.
Engineering decisions above were made to *reduce* this surface, not to clear it.

- **Controlled-drug dispensing** (PCN / NAFDAC territory): we are betting that
  "tooling-only for licensed pharmacies" keeps HID out of regulated practice.
  This bet should be confirmed by someone qualified in Nigerian pharmacy
  regulation.
- **Data protection (NDPA / NDPR):** consent, data residency, NIN handling, and
  patient data rights need a privacy/legal review. The consent-by-action model
  (§2) is designed to support this but does not substitute for it.
- **NIN handling (NIMC):** verification method and storage (tokenized, never
  primary key) need confirmation against NIMC rules.
- **AI lab interpretation (§8):** highlighting/interpreting abnormal values for a
  patient sits near the Software-as-a-Medical-Device line. Treat as regulated
  until a qualified review says otherwise.
- **If institutional billing is ever reintroduced:** re-opens CBN / PCI
  questions. New decision, not an extension.

**Action:** assign an owner to get professional regulatory + data-protection
review before the controlled-drug, NIN, and AI-interpretation features ship.

---

## 12. Build sequencing

The monetization doc called pharmacy "Phase 1." It isn't the first brick  - 
**the patient consent keystone is**, because every institution lookup screen
(hospital, lab, pharmacy) is dead until a patient can approve a request.

1. **Decision record** (this file) - committed first, so all three of us build
   from one model. ✅ you're reading it.
2. **Patient approval/denial consent UI** (the keystone) - wired to the existing
   `access-request-approve` / `-deny` backend. Unblocks every institution surface.
   *(Before building: read `access-request-approve/index.ts`, `break-glass/index.ts`,
   the `hid_create_access_request` migration, and an existing patient page to
   match real loading/error/empty + realtime patterns.)*
3. **Pharmacy POS** - walk-in first (the common, ungated case), then opt-in
   linking, then prescription `fulfillment`.
4. **Lab workflow** - order queue, processing states, result upload + delivery.
   Consent-gated lookup. (AI interpretation gated on §11.)
5. **Hospital clinical workflow** - consultation → prescription → lab order,
   feeding the pharmacy/lab flows above.

---

## 13. Suggested team split (for parallel work without collisions)

Natural seams given the existing domains:
- **Database + Edge Functions** - RPCs, migrations, RLS, audit integrity.
- **Patient surfaces** - consent keystone, timeline, notifications.
- **Institution portal** - pharmacy POS first, then lab/hospital.

The **consent gate is the shared dependency.** Whoever owns it is on the critical
path; the other two build against its contract. Agree the request/grant contract
shape early so the institution and patient sides can be built in parallel.

---

## 14. Outreach / mobile healthcare - a node type, not a new system

Outreach (NGOs, mobile clinics, vaccination campaigns, community health workers,
emergency response) is the **OUTREACH UNIT** node type from §4 - a mobile-first,
stripped-down operational surface, **not** a separate patient system and **not** a
mini-hospital.

What reuses existing patterns directly (no new model):
- **Identity** - outreach patients are HID patients (§7). No parallel patient store.
- **Encounters, referrals, vaccinations, field medication, mobile lab collection**  - 
  the same audited, RLS-scoped, thin-handler-→-RPC pattern as every other node (§9),
  with a lightweight mobile UI.
- **Consent** - field disclosure still runs through the consent gate (§1-§2);
  the only difference is *how* consent is captured when offline (see §15).
- **Patient visibility** - outreach visits/vaccinations/referrals/follow-ups appear
  in the **existing** patient portal (paired-flow, §0). No separate patient view.

New tables (additive, RLS from first migration): `hid_outreach_campaigns`,
`hid_outreach_workers`, `hid_outreach_encounters`, `hid_vaccinations`,
`hid_outreach_referrals`, `hid_sync_queue`, `hid_mobile_lab_samples`. Workers are
**scoped by campaign** (an outreach worker sees only their campaign's patients/data).

**Monetization stays removed (D6).** NGO/government *contracts* are offline
commercial arrangements, not in-app money flows, so they don't reintroduce the
payment-processing surface regardless - but no billing/transaction code in-product.

The genuinely hard part of Outreach is **offline**, governed next.

---

## 15. Offline governance - tiered, not offline-everywhere

"Offline" means two different things, and conflating them re-opens the privacy
holes we closed in §2. We separate them and tier access deliberately.

**The distinction:**
- Offline **capture** (creating data locally, queue, sync later) is safe - worst
  case is a sync conflict.
- Offline **reading of patient data** requires caching records on a device, with
  no server to verify a grant, no live audit, nothing to auto-expire. That is the
  cold-data-on-a-device leak from §2 - and worse on a losable phone.

### The three tiers
- **Tier 0 - online required (by design).** Consent/grant *issuance*, **break-glass**,
  and **controlled-drug authorization**. These need live server verification;
  requiring a connection is a *safety feature*. If there's no signal, the patient
  (who is present) waits - exactly like any clinic system. Break-glass containment
  (notify / auto-expire / admin-review) does not exist offline, so break-glass is
  never offline. Controlled-drug dispensing against stale local stock = double-
  dispensing + unauditable handling; not allowed (protects §4).
- **Tier 1 - offline capture + sync. ALL node types get this.** Encounters,
  vaccinations, lab result uploads, walk-in **sale records**, inventory deductions,
  clinical notes. Created locally, queued, **replayed to the server with full audit
  on sync.** This is resilience to a dropped connection - not full disconnection  - 
  and every portal (hospital/lab/pharmacy/outreach) should have it.
- **Tier 2 - full offline-first, including cached *reads* under locally-captured
  consent. OUTREACH ONLY.** The field context (no signal under a tree, high volume)
  justifies the cost and on-device risk; no other node does this.

### Offline consent (Tier 2)
Consent is **captured locally** - patient signature / PIN / thumbprint  - 
**signed and timestamped on-device**, queued, and **replayed to the server as a
real grant + audit event on sync.** It is never a silent bypass: an offline
disclosure that never reconciles is a defect, not an accepted state.

### Offline identity (Tier 2) - the duplicate-patient risk
"Generate a temporary local ID offline, reconcile later, avoid duplicates" (spec
§8/§16/§17) hides a hard problem: two workers register the same person at two
sites, both offline, both mint temp IDs → a **duplicate patient in a medical
system**, which is a safety risk (split vaccination history → wrong dose), not a
nuisance. `hid_sync_queue` + the conflict-resolution UI must treat dedup/merge as
a designed, human-reviewed flow - **never an automatic merge.**

### Build once, reuse by tier
One shared **infrastructure layer** (Infrastructure/Database domains), consumed by
each node *at its allowed tier*:
- sync engine (queue, retry, replay-with-audit)
- identity reconciliation / dedup service
- on-device encryption-at-rest + lost/stolen/shared-device story
- local-consent capture + replay primitive

A pharmacy uses the sync engine for Tier-1 sale capture; outreach uses the same
engine **plus** Tier-2 cached reads. Same engine, different permissions.

### Sequencing
**Offline is an architecture, not a bolt-on.** The shared infra layer (esp. sync +
identity reconciliation) is designed **before** the Outreach UI modules - building
them online-first then retrofitting sync means rewriting them.

### OPEN - needs review (extends §11)
**Offline patient-data-at-rest** (encryption on device, lost/stolen/shared-device
wipe, worker-to-worker device sharing) intersects the **NDPA** obligations already
flagged in §11. Assign a security + data-protection review before any Tier-2
cached-read capability ships.

---

## 16. Inpatient consent + hospital billing posture

The full hospital information system (HIS) on HID identity required two
extensions to the governance model. Both are ratified here.

### 16.1 Care-episode grant (extends D1/D2 for inpatient)
Per-request consent (D1/D2) is correct for outpatient and ambulatory care. It
does **not** scale to inpatient - a single admission is touched by dozens of
clinicians across shifts. Per-screen re-prompting would be operationally
impossible. The model:

- **Admission itself is a consent event** by the patient (or, for incapacitated
  patients, a documented legally-authorized surrogate - ⚠ surrogate-consent
  rules still need clinical-governance review; see DECISIONS §11).
- Admission produces a **care-episode grant** scoped to:
  - the **admission** (starts at admission, **auto-expires at discharge**),
  - the **assigned care team** (attending, nurses rostered to the ward, paged
    consultants), maintained as a **roster**.
- **Adding a clinician to the care team is the audited access decision** - not
  each chart open. No per-screen re-prompting during an active care-episode
  grant.
- **Break-glass (D3/D4) remains** for access *outside* the care team (an
  out-of-team consultant called urgently, a clinician from another department).
  Clinical-only; four-part contract unchanged.

### 16.2 Hospital billing posture - record, don't process
A real HIS must support patient checkout (totalling the bill) and the hospital
seeing what it made. The line, ratified:

- **HID records the clinical event as billable items.** Services rendered
  (admission days, procedures, medications administered via MAR, consumables,
  ward fees) × configured unit cost = itemized bill - same idiom as pharmacy
  inventory (D7).
- **HID stores payment-occurred** (method, amount, paid flag) at checkout. HID
  does **not** process, hold, or move money. The patient pays the hospital
  through whatever channel the hospital already uses (cash, the hospital's own
  POS terminal, transfer); HID records that it happened.
- **The hospital sees its own revenue inside HID** - today / this week / this
  month, by service, by department, with the audit trail back to specific
  billable events. **This is the hospital's operational view of its own data**,
  not HID's books and not an authoritative finance system. The hospital's
  accountant still reconciles against bank/HMO settlements outside HID.
- HID does **not** aggregate revenue across hospitals into HID-level revenue.
  Monetization (D6) stays removed; HID earns nothing from hospital billing.
- **The payment method captures the scheme.** "Paid with HMO" captures **HMO
  name** (Hygeia, Avon, Reliance, NHIS, corporate scheme, etc.), **claim or
  authorization number**, **scheme member ID**, **copay collected from patient**,
  and **balance billed to scheme**. **HID stores; HID does not transmit, broker,
  or process the claim.** The hospital's existing HMO relationship handles the
  money. Same posture for NHIS, corporate schemes, private insurance.
- **Two ledgers stay architecturally separate:** patient ↔ hospital funds
  (outside HID, *recorded* only) and hospital ↔ HID funds (**none**  - 
  monetization removed).

### 16.3 Pharmacy-side reuse
Pharmacy POS (D7) already follows the same "record, don't process" pattern.
A pharmacy revenue view (its own data, hospital-style) is **not** built yet  - 
if/when added, mirror §16.2 exactly.

---

## Decision log (quick reference)

| # | Decision |
|---|---|
| D1 | One consent gate, two doors (consent + break-glass). |
| D2 | Consent by action - no cold-lookup ever resolves a patient. |
| D3 | Break-glass is clinical-only (hospital/clinic/consultant); pharmacy & lab never. |
| D4 | Break-glass logs *what was viewed*, plus reason/notify/expire/review. |
| D5 | Pharmacies & labs are tooling-only; HID records, never authorizes. |
| D6 | HID does not process or hold money; monetization layer removed. |
| D7 | Pharmacy POS: one transaction, three resolutions (walk-in unlinked / walk-in linked / fulfillment). |
| D8 | Pharmacy sees per-prescription line-item dispensing status, not drug history. |
| D9 | HID number is canonical; NIN is alternate, tokenized, NIMC-verified, never unlocks alone. |
| D10 | Canonical app root is `/src` + `retired_identity_backend/`; `/client` and `/server` are legacy. |
| D11 | New "Doctor"-named files avoided; Staff/Clinical vocabulary going forward. |
| D12 | Build order: decision record → consent keystone → pharmacy → lab → hospital. |
| D13 | Regulatory items (controlled drugs, NDPA, NIN, AI interpretation) are OPEN - need professional review before shipping. |
| D14 | Outreach is the OUTREACH UNIT node type - mobile-first, reuses HID identity/encounter/referral/consent patterns; not a separate patient system. Workers scoped by campaign. |
| D15 | Tiered offline: T0 online-required (consent issuance, break-glass, controlled-drug auth); T1 offline-capture+sync for ALL nodes; T2 full offline-first reads under local consent for OUTREACH only. |
| D16 | Offline consent is captured locally (signed + timestamped) and replayed to the server as a real grant + audit on sync - never a silent bypass. |
| D17 | One shared offline infra layer (sync engine, identity dedup/reconciliation, on-device encryption + lost-device story, local-consent capture/replay), consumed by each node at its allowed tier. |
| D18 | Offline identity dedup/merge is a human-reviewed flow, never automatic (duplicate patient = safety risk). |
| D19 | Offline patient-data-at-rest (device encryption, lost/stolen/shared-device) is OPEN - needs security + NDPA review before any T2 cached-read ships. |
| D20 | Offline infra (sync + identity reconciliation) is designed before Outreach UI modules - it's an architecture, not a bolt-on. |
| D21 | Care-episode grant - admission creates a grant scoped to the admission + the assigned care team, auto-expires at discharge; care-team membership is the audited access decision (no per-screen re-prompting). Break-glass (D3/D4) still covers out-of-team access. |
| D22 | Hospital billing posture - HID records itemized bills + payment-occurred (cash/transfer/HMO/NHIS/insurance with claim, scheme ID, copay, balance billed); hospital sees its own revenue inside HID as an operational view; HID never processes money; no HID-level revenue aggregation. |
