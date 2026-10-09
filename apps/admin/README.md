# HID Super Admin

`apps/admin` is the authenticated React/Vite administration application for
HID platform governance. It uses Identity authentication and explicit
platform-scoped memberships, and reaches `/api/v1/admin/*` only through the HID
gateway.

It has no PostgreSQL client, database credential, SQL console, direct service
host, clinical mutation, OCR-validation, Lab-result, Pharmacy-dispensing, or
break-glass authority.

## Local use

From the repository root, `npm run dev` serves the application at
`http://localhost:3000/admin/`; its loopback-only direct port is 3105. Run the
package independently with `npm --prefix apps/admin run dev`.

## Verification

```text
npm --prefix apps/admin run lint
npm --prefix apps/admin run typecheck
npm --prefix apps/admin test
npm --prefix apps/admin run build
```

The application requires the gateway plus Identity API. Operations views also
require the configured owner-service and dispatcher status URLs. Missing
dependencies render explicit unavailable states; no fixtures or sample counts
are used as runtime fallbacks.

Sensitive mutations require server permissions, CSRF/Origin validation,
`Idempotency-Key`, `If-Match`, a reason, confirmation, semantic audit, and the
owning Identity command. Frontend guards and navigation visibility are UX only.
