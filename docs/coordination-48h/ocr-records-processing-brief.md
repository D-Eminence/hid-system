# OCR "Records processing" purpose: recommended design (31 Oct 2026)

RECOMMENDED: "RECORDS PROCESSING" FOR OCR, BUILT IN THREE STAGES

What it is
Records processing is its own permission, separate from care. It lets a facility's staff scan a patient's paper records, have software read them, check the result and confirm whose record it is. It never opens the patient's chart. Putting the result into the chart stays a care step, done by a doctor, clinician or nurse who already has the patient's care permission.
Today no OCR job can run. Records processing has never been switched on, so no permission for it can exist, and the system answers "not found" (not "access denied" as the brief said).

What the patient sees
- Stage 1: an inbox item and an Access and consent entry: "Demo Hospital asks to process your paper records (Records processing)", with the reason and how long (up to 24 hours). They approve or decline. Access history then shows "Records processing" with its dates and a Revoke button. Revoking stops every further OCR step at once.
- Stage 2: the access log says "processed a paper record" instead of "viewed", and the daily notice names records processing.
- Stage 3: a "Don't digitise my records at this facility" switch, and one notice per migration project.

What staff do
- Stage 1: in Migrate, a staff member uploads the scan using their care access, as today, and presses "Ask the patient for records processing". Once the patient approves, they extract, check and confirm the patient. A doctor, clinician or nurse with care access then publishes the result to the chart.
- Stage 2: a new Records officer role for records staff. They can find the patient, upload, run OCR, check and match. They cannot see the chart or publish to it.
- Stage 3: records staff run migration projects. They bulk-upload paper back-files and run OCR. A matching queue finds the patient, and a second person confirms weak matches. Clinicians then publish.

What we build
Stage 1, ready for the demo (about 4 days):
1. Website, released first (1.5 days). Show the purpose in plain words on requests, history and inbox items. Add the "Ask the patient" panel to Migrate and Document OCR. Replace "Document not found" with a clear message. Show the purpose in the staff audit view.
2. Database change 0100 (1.5 days). Switch on "Records processing". Include the purpose in the patient's request list. Allow only staff who can run OCR to ask. Prove it in tests and prepare the release papers for you to sign.
3. Safety fence (0.5 day). Imported records, the reported health profile, Lab and Pharmacy all refuse records-processing access, so it reaches documents and OCR only.
4. Demo rehearsal on Demo Hospital (0.5 day). This can happen once OCR publishing (#136) and the upload fix are live. Demo flow: operations@ asks, patient1@ approves, OCR runs, publish, then revoke.
Stage 2, before any real facility uses it (about 8 days):
5. Lock the fence into the database itself, so a future screen cannot leak the chart (3 days).
6. Patient transparency: access log, daily notice, and a revoke that also blocks publishing anything still unfinished (2 days).
7. Records officer role, a document list that does not need a visit, and upload without care access (3 days).
Stage 3, bulk migration (15 to 25 days, a separate design after legal advice):
8. Migration projects, each with a named approver, legal basis and impact-assessment reference. Bulk intake held apart from any patient's record. A matching queue. Permission limited to the project and to patients the facility actually treated. The opt-out switch.

Decisions for you (recommended answer in brackets)
1. Patient-facing name: "Records processing"; the internal code stays healthcare-operations. [Yes]
2. Stage 1 permission comes only from the patient's approval. Nothing is pre-seeded, and the demo shows patient1@ approving live. [Yes]
3. Length of one request. [24 hours, the current maximum]
4. Who may ask and run OCR in Stage 1: doctors, clinicians, nurses and lab staff, who already hold OCR rights. Pharmacists and receptionists cannot. [Yes, including lab]
5. Publishing stays with a doctor, clinician or nurse who has care access. After a revoke, nothing more from that job is published. [Yes to both; the second part lands in Stage 2]
6. Release order: website first, then the backend; you sign the 0100 declaration. [Yes]
7. Off switch: turning Records processing off stops it everywhere. [Only you decide, and each use is recorded]
8. Legal basis for bulk migration. Consent alone does not work, because patients without accounts could never be migrated. [Ask Nigerian counsel to confirm the facility's record-keeping duty, combined with notice and a right to object, limited to its own patients. Complete an impact assessment before any real facility starts.]
9. Data leaving Nigeria: the OCR service runs in AWS Ireland (eu-west-1) by default. [Fine for the fictional demo. Before real patients, put transfer safeguards in place and say so in the privacy notice.]
10. Children. [Records processing for under-18s waits until a guardian can approve]

Why this mix
Stage 1 is the "hybrid" design: it is the only one that fits today's permission system and can be demo-ready in days. Stage 2 adds the database lock and patient visibility from the patient-consent design. Stage 3 takes projects, matching and the right to object from the facility-policy design, once counsel has chosen the legal basis.

## Corrections the judges made to the three designs

- (Brief) The claim that 'every OCR job is refused 403 OCR_ACCESS_DENIED' is wrong. OCR asks EHR for the document source first (ocr-api ocr.service.ts:133, :719). EHR reads ehr.documents_effective under the forwarded purpose (ehr-api document.service.ts:162-176, :326-337), and row-level security hides the row (0005:387-388, 0005:24-44). Create therefore returns 404 NOT_FOUND and the other job routes return 404 OCR_JOB_NOT_FOUND (ocr.service.ts:719-731). All three designs state this correctly.
- (patient-consent) The design does not flag that redefining identity.has_active_consent_grant (0012:5-104) touches a function whose md5 is pinned in five places: 0091_order_route_cannot_complete.sql:319-320, 0094_patient_parity_profile.sql:293, 0095_patient_sharing.sql:266, 0098_sealed_demo_tenant.sql:464, and services/ehr-api/test/database/order-routes-cannot-complete.integration.sql:1740. Replaying the migrations on a fresh database still works, because each migration pin runs before 0100. The integration-suite pin would fail and would need updating.
- (patient-consent) records_officer cannot find the patient. The role omits identity.patient.read, which POST /identity/patient-lookup requires (identity-api identity/identity.controller.ts:40). It also omits identity.consent.read, which consent-status requires (identity.controller.ts:127). Migrate's capture screen calls both (health ehr-blue/departments/migrate/DocumentCapture.tsx:77-99).
- (patient-consent, facility-policy) Records-only staff cannot list documents under healthcare-operations. GET /ehr/documents requires encounterId (ehr-api documents/dto/list-documents.dto.ts:5), and the encounter routes accept direct-care only (ehr/shared/clinical-context.ts:7-12, used by DocumentCapture.tsx:118). Neither design budgets for a patient-level document list. Upload itself is fine, because encounterId is optional (create-document-upload.dto.ts:20).
- (patient-consent) 'The 24-hour minute limit no longer applies' is not true at the table level. The CHECK requested_duration_minutes between 5 and 1440 still binds every access_requests row (0003_consent_and_audit.sql:76), so the patient's chosen 7, 30 or 90 days has to be stored somewhere else.
- (facility-policy) Widening only documents_read, documents_insert and documents_update (0005:387-393) breaks OCR. ehr.documents_effective is security_invoker and left-joins ehr.document_scan_events (0009_document_scan_object_binding.sql:226-262), whose staff policy is context_allows read_records (0005:397-398). A records_processing grant never satisfies that policy, so scan_status reads 'pending' and status reads 'uploaded'. OCR create then refuses with 409 OCR_SOURCE_NOT_ELIGIBLE (ocr.service.ts:134-136), and demo step 4 fails. document_scan_events_staff_read must be widened too, as patient-consent does.
- (facility-policy) A single 'records_processing' scope breaks browser reads. For a delegated cookie request with a safe method, Identity's service route refuses any scope except read_records with 403 CSRF_VALIDATION_FAILED (identity-api identity.controller.ts:66-70; auth/security.guard.ts:60-61, 214-226). The OCR job, extraction and validation GETs and the EHR document list, download and ocr-source reads would all fail. The design needs separate read and write variants, or must keep read_records and write_records tied to the purpose.
- (facility-policy) Minor citation errors. The live control-key constraint is control_settings_control_key_check as redefined at 0086_provider_self_service_onboarding.sql:10365, not 0039:13-16. consent_grants_authorization_method_ck was created at 0033:101-102; 0095:301-302 is a pinned-definition check, not the definition. The read/write-only rule in has_active_consent_grant is at 0012:24, not :28.
- (hybrid-mvp) Switching patient-records.controller.ts:55 and :66 to clinicalContext would also remove emergency-purpose reads of imported records and attachments, which the staff API allows ('direct-care' | 'emergency', health staff/api.ts:1867-1872). Today's callers pass direct-care only (staff/routes/Clinical.tsx:1790, ehr-blue/clinical/consult/TodaySections.tsx:45), so nothing breaks now. The safer fence refuses only healthcare-operations on these routes.
- (hybrid-mvp) The 1.5-day estimate is optimistic. 0100 still needs the PG16 proof, the ledger, components and compatibility declaration (as in 0099), and a website release that ships before the backend. About 3 to 4 days is realistic.
- (hybrid-mvp) Minor: staff/routes/Operations.tsx:1472 is where the Ocr component starts. createOcrJob is called at Operations.tsx:1576, and in Migrate at ehr-blue/departments/migrate/Migrate.tsx:233.

## Scores (0-10; effort: higher means less work)

- patient-consent.privacy: 9 — Strongest consent model: the patient gives explicit consent for one facility, for a fixed time, with the notice version stored. The database fence covers documents and scan events only (0005:387-398), and care consent never opens OCR. Weak points: it opens all of a patient's documents at the facility, and the new 403 on create tells staff whether the patient has consented.
- patient-consent.fit: 4 — Adds a second consent store alongside consent_grants. It redefines has_active_consent_grant, which is md5-pinned (0091:319, 0094:293, 0095:266, 0098:464, order-routes-cannot-complete.integration.sql:1740), and it reworks create_access_request and approve.
- patient-consent.effort: 3 — About 18 days (higher score means less effort): roughly 1,300 lines of SQL, a new Identity module, portal screens and a PG16 test suite.
- patient-consent.demo: 6 — The script is complete and uses a real live approval. It needs the new records_officer role row (98d00006-...-0013 is free; G3 at 0098:1523-1537 refuses only platform roles). Uploading under healthcare-operations still depends on the direct-care encounter list. The demo is about 3.5 weeks away.
- patient-consent.bulk: 6 — Facility-level consent survives staff turnover, and the plan covers intake and a matching queue. But a consent-first model stalls for back-file patients who have no account, and the design admits this.
- facility-policy.privacy: 6 — The fence by design is strong: the new scope cannot satisfy has_active_consent_grant (0012:24), and patients can object. But the patient takes no action at all. Staff open 7 to 30 days of processing on the strength of any care basis, even a 60-minute PIN grant. Patients without a portal login see nothing.
- facility-policy.fit: 6 — Reuses consent_grants rows and leaves the pinned context_allows alone. It does add a new scope, a new method, new constraints, a side table, and the first code that writes deny directives. The single scope also clashes with the delegated-GET CSRF rule (identity.controller.ts:66-70).
- facility-policy.effort: 3 — About 17 days, of which roughly 450 lines are copied function bodies that must be checked against the md5 pins.
- facility-policy.demo: 4 — Fails as written. Scan events stay hidden (0009:226-262, 0005:397), so create returns 409 OCR_SOURCE_NOT_ELIGIBLE (ocr.service.ts:134-136). Browser GETs under the records_processing scope get 403 CSRF_VALIDATION_FAILED. Both bugs can be fixed. The single-login seeded policy is otherwise neat.
- facility-policy.bulk: 8 — Best fit for bulk work: a project_id and basis_kind hook, four-eyes approval of projects, a basis of patients the facility actually treated, objection instead of opt-in, and intake held apart from patient records.
- hybrid-mvp.privacy: 7 — Explicit per-request consent, and it refuses to ship until the purpose label is visible. The fence is in the services only: at the database, a write_records healthcare-operations grant passes ehr.context_allows on every clinical table (0005:24-44). The access log still shows OCR work as 'viewed'.
- hybrid-mvp.fit: 9 — Uses the existing request, approve, grant and authorize path unchanged (0098:1681-1686, 0072:88-99, 0012:27-40). The new trigger keys on ocr.job.write, and no pinned function is touched.
- hybrid-mvp.effort: 9 — Claims 1.5 days. About 3 to 4 days is realistic once the PG16 proof, ledger and declaration, and a website-first release are counted.
- hybrid-mvp.demo: 8 — Uses the seeded direct-care share for upload and publish (0098:1391-1450) plus a live patient1@ approval. It depends on OCR publishing (#136, ocr.service.ts:404-406) and upload CORS.
- hybrid-mvp.bulk: 4 — On day one access is per staff member, per patient, for at most 24 hours (create-access-request.dto.ts:22-24). Its B1-B4 roadmap is sound but mostly unbuilt, and the database fence is deferred.
