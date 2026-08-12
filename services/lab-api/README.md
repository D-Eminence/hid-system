# HID Lab API

Independent NestJS service owning Lab APIs, workflow enforcement, persistence access, semantic audit, and transactional outbox writes. Public routes remain `/api/v1/lab/*`; local development uses port `3003`.

Run `npm run start:dev`, `npm test`, `npm run typecheck`, or `npm run build` from this directory. Health endpoints are `/api/v1/health/live` and `/api/v1/health/ready`; readiness checks PostgreSQL.

The service uses `LAB_DATABASE_URL`; its login inherits `hid_lab_api_runtime` (Lab plus append-only audit), never migration-administrator or EHR/Identity mutation privileges. Actor authentication and patient authorization are resolved through the shared typed client over `IDENTITY_API_URL` (port 3001 locally), with separate propagated-user and Lab workload credentials. EHR/OCR-only commands additionally require service identity. The root dev launcher generates distinct ephemeral local tokens. Production requires JWT workload identity in both directions, HTTPS issuer/JWKS validation for inbound EHR/OCR calls, and a rotating Identity-audience token mounted through `IDENTITY_LAB_WORKLOAD_TOKEN_FILE`; local-secret mode is rejected. Applied migrations remain in the historical central ledger during extraction. Future ownership must be transitioned without forking that ledger.

See `docs/ARCHITECTURE.md`, `docs/INTERFACE_CONTRACT.md`, `docs/SECURITY.md`, and `docs/DATABASE.md` for authoritative boundaries.

Build the container externally from the repository root with `docker build -f services/lab-api/Dockerfile -t hid-lab-api .`. The root `.dockerignore` excludes local environments, credentials, token files, build outputs, and dependency trees.
