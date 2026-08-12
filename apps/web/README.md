# HID Identity Portal

This package contains the React and Vite patient, facility, admin, Outreach,
and HID Migrate experiences. It is part of the consolidated HID repository and
uses the first-party HID REST API for authentication and application commands.

## Runtime architecture

- React, Vite, and React Router provide the browser application.
- Authentication uses HttpOnly cookies, CSRF validation, and `/api/v1/auth`.
- Application commands use the configurable first-party function gateway.
- The browser receives no database credential, service-role credential, or
  general object-storage credential.
- PostgreSQL and NestJS are the authoritative server boundary for new EHR,
  identity authorization, consent, and audit work.

The retired second backend and its browser SDK are not part of this package.
Historical comparison material remains only under the repository-level
`upstream_snapshot` reference.

## Main folders

- `src/` contains the active frontend.
- `src/lib/identityClient.ts` owns the REST session boundary.
- `src/lib/functionApi.ts` owns shared function-gateway response handling.
- `src/features/migrate/` contains the digitization and migration workspaces.
- `public/` contains static assets, PWA files, and crawl metadata.
- `scripts/` contains repository contract verification.

## Local development

Run from the repository root:

```bash
npm run dev
```

Open `http://localhost:3000/`. The root gateway also exposes the EHR at
`http://localhost:3000/ehr/` and proxies `/api` to the NestJS service when its
required environment is configured.

For this package alone:

```bash
npm install
npm run dev
```

Optional frontend configuration:

```env
VITE_HID_IDENTITY_API_URL=
VITE_HID_FUNCTIONS_PATH=/api/v1/functions
VITE_TURNSTILE_SITE_KEY=
VITE_SENTRY_DSN=
VITE_SENTRY_ENVIRONMENT=production
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
VITE_POSTHOG_KEY=
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

An empty API URL means same-origin requests, which is the normal localhost
configuration.

## Routes

- `/patient` and `/patient/*` - patient authentication and portal flows
- `/hospital` and `/hospital/*` - facility and staff flows
- `/outreach/*` - Outreach onboarding and workspace
- `/migrate/*` - controlled migration workspace
- `/eminence/*` - private platform administration
- `/pricing`, `/products`, and `/configure-ehr` - public product flows

## Verification

```bash
npm run verify:identity
npm run verify:api
npm run verify:migrate
npm run build
```

The build validates cryptographic HID generation, governed consent commands,
the first-party REST session client, shared API response handling, and strict
TypeScript compilation.

## Security rules

- Never put server secrets in a `VITE_*` variable.
- Never store access or refresh credentials in local storage.
- Keep PHI out of analytics, logs, URLs, and browser error reporting.
- Require server-side facility, permission, purpose, consent, and audit checks.
- Treat missing durable dependencies as explicit failures, never simulated
  success.
