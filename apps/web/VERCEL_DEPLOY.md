# Retired HID 1.0 hosting note

Vercel was part of the HID 1.0 hosting history. It is not a deployment target
for the canonical platform and this file contains no deploy procedure.

The approved frontend boundary is the independently deployable Cloudflare
Worker Static Assets configuration under `infra/cloudflare/`. Hostinger remains
the registrar. AWS hosts the API/data/worker boundary. Follow the authoritative
Cloudflare and AWS runbooks; do not recreate a Vercel project or place secrets
in frontend-local environment files.
