# OCR to FHIR: owner decisions (D-Eminence, in chat, 1 Nov 2026)

1. Engine and region: Amazon Textract plus Claude on Amazon Bedrock, EU-wide (the Bedrock EU cross-Region profile), behind an approval switch that is off by default.
2. A paper prescription is filed as medicine history (FHIR MedicationStatement) and never as an active, dispensable order: "Yes".
3. Pharmacy guard: "Fix it now". Pharmacy same-facility acceptance must match a real, active EHR prescription.
4. Patients see imported items as soon as they are filed, labelled as from a paper record. Staff can hold back sensitive items, with a reason.
5. Code systems as recommended:
   - ICD-10 (WHO), with ICD-11 as a second code;
   - LOINC, UCUM and CVX;
   - an HID formulary from the Nigeria Essential Medicines List plus ATC;
   - SNOMED deferred.
   Owner asked: "can we add things like hid into them". Answer: yes.
   - The Health ID goes on every exported record as a Patient.identifier, with an HID-owned identifier system URI. It is not the FHIR logical id, per docs/DATABASE.md.
   - An HID local CodeSystem covers items the standard lists lack, mapped to a standard code when one exists.
6. Privacy: "All done. We are NDPC Certified". DPIA, record of processing and patient notice are done.
   - Still to confirm: the AWS Organizations AI-services opt-out policy (an account setting outside the repo).
7. Pilot: "MoU signed with Facility".
   - Still needed before the pilot: the facility's name in Health ID, and the clinical safety lead.

Build order: the Pharmacy guard now. OCR Stage 2 after the virus scanner and Records processing (Stage 1) are live.
