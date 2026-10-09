# Health ID demo request backend contract

The future Health-id frontend can submit its Book Demo form to the Identity API. This backend contract does not change the current Health-id frontend or make Health ID API a public API signup.

## Public intake

`POST /api/v1/commercial/demo-requests` returns HTTP 202 with `{ "accepted": true, "replayed": false }`. Send an `Idempotency-Key` header containing 16–128 URL-safe characters and an allowed `Origin`. The request body is:

```json
{
  "contactName": "Ada Example",
  "contactEmail": "ada@example.org",
  "contactPhone": "+2348000000000",
  "contactRole": "Operations lead",
  "organizationName": "Example Clinic",
  "organizationType": "clinic",
  "productCode": "ehr",
  "message": "We would like a walkthrough.",
  "sourcePage": "/products/ehr",
  "sourceSection": "closing",
  "ctaLabel": "Book demo",
  "turnstileAction": "book-demo",
  "turnstileToken": "widget-token"
}
```

Only `contactName`, `contactEmail`, `productCode`, `turnstileAction`, and `turnstileToken` are required. Product codes are `ehr`, `migrate`, `laboratory`, `pharmacy`, `outreach`, `api`, and `general`. The API product remains a demo interest code. Optional source fields must describe the page and CTA without including query strings, tokens, patient data, or other personal information. The existing Health-id form's `facility`, `role`, `service`, and `notes` map to `organizationName`, `contactRole`, `productCode`, and `message`. Its current free-text `service` needs an explicit product-code mapping during the later frontend integration.

The backend validates the exact origin and a single-use Turnstile `book-demo` action in staging and production. A repeated idempotency key returns `{ "accepted": true, "replayed": true }` without creating another request. Contact details remain in the Identity-owned table; semantic audit records only the selected product and request ID.

## Platform administration

`GET /api/v1/admin/demo-requests?status=new&productCode=ehr&limit=50` requires `platform.demo.read` and returns `{ "items": [...], "nextCursor": "..." }`, newest first, with contact, organization, source, status, version, and timestamps. `limit` is 1–100 (default 50). `nextCursor` is null on the last page; otherwise send it back as `cursor` with the same filters. A cursor is opaque, and one that is altered or was issued for other filters is `400 ADMIN_INVALID_CURSOR` (Stage 4A). `POST /api/v1/admin/demo-requests/{requestId}/status` requires `platform.demo.manage`, an `If-Match` header containing the current version, and `{ "status": "contacted", "reason": "Reached the requester by email" }`. States are `new`, `contacted`, `qualified`, and `closed`. Successful transitions write immutable state events and semantic audit in the same transaction. There is no public list, edit, or admin signup route.
