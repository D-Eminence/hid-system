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

Product codes are `ehr`, `migrate`, `laboratory`, and `pharmacy`. Organization types are `clinic`, `hospital`, `laboratory`, `pharmacy`, and `other`. The `RC`/`BN`/`IT` registration identifier is normalized for whitespace and case. Public intake does not accept an applicant-supplied legal company name or other registry details. A duplicate open application for the same CAC and product returns the same generic response. No application ID, duplicate status, raw CAC, or provider response is returned. Admin is not a signup product; Health ID API continues to use Book Demo. Outreach uses its existing authorized workspace onboarding.

## Platform review

All routes below require authenticated platform permissions, a current active staff membership, and an `X-Facility-ID` context. Mutations require `If-Match: <version>` to prevent stale decisions.

| Route | Permission | Result |
| --- | --- | --- |
| `GET /api/v1/admin/organization-applications?status=pending_verification` | `platform.identity-review.read` | Up to 100 applications with a masked CAC hint, verification state, and version. |
| `POST /api/v1/admin/organization-applications/{id}/verify-cac` | `platform.facility.manage` | The server reads the restricted CAC and calls QoreID CAC Basic V2. It records a normalized result and returns state, provider-check outcome, and new version. A verified check can still leave the profile incomplete. |
| `POST /api/v1/admin/organization-applications/{id}/approve` | `platform.facility.manage`, `platform.principal.manage`, `platform.role.manage` | Requires `{ "reason": "Reviewed legal entity" }`; for reuse also pass `existingOrganizationId` and `existingFacilityId`. Returns canonical IDs and new version. |
| `POST /api/v1/admin/organization-applications/{id}/reject` | `platform.facility.manage` | Requires `{ "reason": "Review reason" }`; returns status and new version. |

Verification is disabled when `QOREID_ENABLED=false` or the runtime integration is paused, and a provider failure cannot become an approval. The CAC Basic V2 request sends only the normalized `regNumber`; the [QoreID contract](QOREID_VERIFICATION_CONTRACT.md) defines the exact verified response and registration-number match. A numeric top-level provider `id`, `summary.cac_check=verified`, `status.state=complete`, and `status.status=verified` make the submitted identifier a successful CAC verification even when QoreID omits legal fields or `cac.rcNumber`. If QoreID returns `cac.rcNumber`, its digits and any explicit prefix must match the submitted identifier; a mismatch fails verification. If it does not return the number, the normalized submitted identifier remains the confirmed canonical registration identifier. The application records `verificationResult=verified`, provider reference and check time, plus a separate `profileState=complete|incomplete`. A sparse profile remains `status=pending_verification` until the applicant completes the missing required fields; it does not require another QoreID lookup. A provider-returned non-active registry status remains sourced QoreID evidence but blocks review even though the CAC lookup was verified.

## Applicant profile completion

After a successful CAC lookup, the applicant can use `/provider/complete` with the same product, registration identifier, and administrator email used at intake. The start route requires an allowed Origin and a Turnstile proof with action `organization-completion`. It returns a generic accepted result and sends a six-digit OTP to the application email only when an eligible verified application matches. The OTP is single use, expires after ten minutes, has an attempt limit and resend quotas, and grants a one-hour HttpOnly, SameSite Strict completion cookie after verification. The OTP proves control of the application email, not authority to represent the organization.

| Route | Input and result |
| --- | --- |
| `POST /api/v1/identity/organization-applications/completion/start` | Product, normalized CAC identifier, administrator email, Turnstile action and token; starts a bounded email OTP challenge. |
| `POST /api/v1/identity/organization-applications/completion/verify` | Challenge ID and six-digit code; establishes the completion session. |
| `GET /api/v1/identity/organization-applications/completion/profile` | With the completion cookie, returns the submitted registration identifier, current version, profile state, and each required field's value and source. |
| `PATCH /api/v1/identity/organization-applications/completion/profile` | With the completion cookie and `If-Match: <version>`, accepts only company name, entity type, registration date, address, or active registry status that QoreID did not supply. Returns the updated sourced profile and version. |

Every supplied QoreID value remains authoritative with source `qoreid`; a field missing from QoreID may be completed with source `user_provided`. Applicants cannot overwrite provider-supplied values, including a non-active registry status, and an empty provider value is never represented as authoritative. HID stores provider fields separately from the merged review profile. The profile becomes complete when all five required fields are present and registry status is `active`, regardless of whether each came from QoreID or applicant completion. It then moves to `ready_for_review`. A non-active QoreID registry status leaves `profileState=incomplete` and review blocked; it cannot be changed to `active` through applicant completion. Admin review shows provider-only fields, the review profile, and field sources separately. Profile completion does not approve, activate, or bind the organization.

Approval requires a recorded `verified` CAC result, a complete sourced profile, a unique registration binding, and a reason. A new organization gets an active verified facility, a product enrollment, and a first administrator account in `pending_reset`. The administrator completes the existing email OTP password setup before local signin. An existing organization can only be reused when its explicit IDs match the CAC binding and the submitted email already belongs to an active administrator at that facility. Existing-organization evidence must still satisfy the full persisted binding; sparse provider evidence alone cannot bypass that comparison. Conflicts require manual administrator resolution. CAC Basic V2 does not verify the applicant's authority to represent the organization; platform review remains separate. Direct entitled-sandbox CAC calls confirmed sparse verified RC and BN results; the full activation flow still requires separately reviewed staging acceptance.

The CAC number is stored in the restricted application and binding tables so the server can verify and deduplicate it. It is never returned by public intake, admin lists, or admin verification responses and is excluded from semantic audit details. The OTP-authenticated completion session can read the identifier for its own application. The application records provider state, reference, profile state, per-field provenance, check time, reviewer, reason, and version. Historical `verified_incomplete` records are migrated to `verified` provider state with incomplete profile state; missing historical provider fields cannot be reconstructed. The database runtime has `EXECUTE` on guarded commands rather than direct table mutation rights.

The later frontend integration supplies the product code and Turnstile proof, handles generic 202 responses and problem details, and uses the existing staff OTP and signin flow after approval. It must not derive an administrator session from a public application or profile-completion response.
