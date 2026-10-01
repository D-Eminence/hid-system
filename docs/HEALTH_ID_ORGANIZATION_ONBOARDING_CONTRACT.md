# Health ID organization onboarding backend contract

The future `Health-id` public frontend can submit EHR, Migrate, Laboratory, and Pharmacy organization applications to one governed Identity API path. Product selection does not create four identity systems. Approval binds one verified CAC registration to one canonical organization and its primary facility; additional products reuse that binding after an explicit administrator review.

## Public intake

`POST /api/v1/identity/organization-applications` returns HTTP 202 and `{ "accepted": true }`. An exact allowed `Origin` and a single-use Turnstile proof with action `organization-application` are required in staging and production.

```json
{
  "productCode": "migrate",
  "organizationType": "clinic",
  "cacRegistrationNumber": "RC1234567",
  "administratorName": "Ada Example",
  "administratorEmail": "ada@example.org",
  "turnstileAction": "organization-application",
  "turnstileToken": "widget-token"
}
```

Product codes are `ehr`, `migrate`, `laboratory`, and `pharmacy`. Organization types are `clinic`, `hospital`, `laboratory`, `pharmacy`, and `other`. The `RC`/`BN`/`IT` registration identifier is normalized for whitespace and case. Public intake does not accept an applicant-supplied legal company name or other registry details; those come from the verified QoreID CAC Basic V2 response. A duplicate open application for the same CAC and product returns the same generic response. No application ID, duplicate status, raw CAC, or provider response is returned. Admin is not a signup product; Health ID API continues to use Book Demo. Outreach uses its existing authorized workspace onboarding.

## Platform review

All routes below require authenticated platform permissions, a current active staff membership, and an `X-Facility-ID` context. Mutations require `If-Match: <version>` to prevent stale decisions.

| Route | Permission | Result |
| --- | --- | --- |
| `GET /api/v1/admin/organization-applications?status=pending_verification` | `platform.identity-review.read` | Up to 100 applications with a masked CAC hint, verification state, and version. |
| `POST /api/v1/admin/organization-applications/{id}/verify-cac` | `platform.facility.manage` | The server reads the restricted CAC and calls QoreID CAC Basic V2. It records a normalized result and returns state and new version. |
| `POST /api/v1/admin/organization-applications/{id}/approve` | `platform.facility.manage`, `platform.principal.manage`, `platform.role.manage` | Requires `{ "reason": "Reviewed legal entity" }`; for reuse also pass `existingOrganizationId` and `existingFacilityId`. Returns canonical IDs and new version. |
| `POST /api/v1/admin/organization-applications/{id}/reject` | `platform.facility.manage` | Requires `{ "reason": "Review reason" }`; returns status and new version. |

Verification is disabled when `QOREID_ENABLED=false` or the runtime integration is paused, and a provider failure cannot become an approval. The CAC Basic V2 request sends only the normalized `regNumber`; the [QoreID contract](QOREID_VERIFICATION_CONTRACT.md) defines the verified response and canonical registration binding. Approval requires a recorded `verified` CAC result and a reason. A new organization gets an active verified facility, a product enrollment, and a first administrator account in `pending_reset`. The administrator completes the existing email OTP password setup before local signin. An existing organization can only be reused when its explicit IDs match the CAC binding and the submitted email already belongs to an active administrator at that facility. Conflicts require manual administrator resolution. CAC Basic V2 does not verify the applicant's authority to represent the organization; platform review remains separate.

The CAC number is stored in the restricted application and binding tables so the server can verify and deduplicate it. It is never returned by public intake, admin lists, or API verification responses, and is excluded from semantic audit details. The application records provider state, reference, failure category, reviewer, reason, and version. The database runtime has `EXECUTE` on guarded commands rather than direct table mutation rights.

The later frontend integration supplies the product code and Turnstile proof, handles generic 202 responses and problem details, and uses the existing staff OTP and signin flow after approval. It must not derive an administrator session from a public application response.
