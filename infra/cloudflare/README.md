# HID Cloudflare frontend edge

The seven application directories under `workers/` are independent Cloudflare
Workers Static Assets configurations. Each has one exact custom domain per
environment and invokes the shared Worker before assets, so the fixed
`/api/v1/*` AWS proxy and the response security policy cannot be bypassed.

## Launch subset and the Health-id frontend (ADR-052)

At launch only these Workers are deployed (`launch-deployment.json`):

| Environment | Worker | Host | Serves |
| --- | --- | --- | --- |
| staging | `hid-web` | `staging.healthidentitydirectory.com` | Health-id `apps/patient-web` |
| staging | `hid-admin` | `admin.staging.healthidentitydirectory.com` | Health-id `apps/patient-web` |
| production | `hid-web` | `www.healthidentitydirectory.com` | Health-id `apps/patient-web` |
| production | `hid-admin` | `admin.healthidentitydirectory.com` | Health-id `apps/patient-web` |
| production | `hid-apex-redirect` | `healthidentitydirectory.com` | originless redirect to www |

`hid-ehr`, `hid-lab`, `hid-pharmacy`, `hid-ocr`, `hid-ocr-redirect` and
`hid-outreach` are **not deployed** in either environment: their legacy
hid-system builds are not the launch frontend, and Lab, Pharmacy, OCR and
Outreach are off at launch (D17). Clinicians use the Health-id provider
workspace (`/provider/*`) on www or staging. The TUF repository Workers
(`hid-tuf-staging`, `hid-tuf-production`) are published only by the protected
TUF workflow. `verify-config.mjs` holds the same decided subset and fails if
the manifest deploys anything else or leaves a configured Worker
unclassified.

Not deploying a host does **not** close its API: every deployed Worker proxies
all of `/api/v1`. Deferred modules stay closed at the gateway, whose
`HID_ENABLED_API_ROUTES` proxies only `identity,ehr` at launch and answers
`404 API_ROUTE_NOT_FOUND` for the rest (D-Eminence/hid-system#65,
`infra/aws/src/config.ts` `launchApiRoutes`).

`hid-web` and `hid-admin` have no default asset directory. Each named
environment serves `./staged/<environment>/site`, the Health-id build staged
for that host, with `./staged/<environment>/provenance.json` beside it (not
served). `staged/` is git-ignored: an artefact is never committed.

### Building and staging a Health-id artefact

Each host needs its own build, because the build inlines its origin. In a
checkout of `D-Eminence/Health-id` at the commit being released:

```sh
npm ci
VITE_HID_ENVIRONMENT=staging \
VITE_HID_API_BASE_URL=https://staging.healthidentitydirectory.com \
VITE_HID_APP_ORIGIN=https://staging.healthidentitydirectory.com \
VITE_HID_TURNSTILE_SITE_KEY=<staging widget site key> \
  npm run build:patient-web
```

| Worker and environment | `VITE_HID_ENVIRONMENT` | `VITE_HID_API_BASE_URL` = `VITE_HID_APP_ORIGIN` |
| --- | --- | --- |
| `hid-web` staging | `staging` | `https://staging.healthidentitydirectory.com` |
| `hid-admin` staging | `staging` | `https://admin.staging.healthidentitydirectory.com` |
| `hid-web` production | `production` | `https://www.healthidentitydirectory.com` |
| `hid-admin` production | `production` | `https://admin.healthidentitydirectory.com` |

`VITE_HID_TURNSTILE_SITE_KEY` is the site key of that environment's widget.
Leave `VITE_HID_GOOGLE_CLIENT_ID` and `VITE_HID_SENTRY_DSN` unset (Google
sign-in is off at launch; no error-reporting processor is approved). Use no
`.env.local` with other values. Then, from this repository:

```sh
node infra/cloudflare/scripts/stage-health-id-build.mjs \
  --worker hid-web --environment staging \
  --build <Health-id>/apps/patient-web/dist \
  --source-commit <full 40-character Health-id commit>
```

The script refuses, and writes nothing, unless the build:

- inlines `VITE_HID_ENVIRONMENT` equal to the environment and
  `VITE_HID_API_BASE_URL` and `VITE_HID_APP_ORIGIN` each exactly
  `https://<host>` (same-origin cookie sessions);
- has a deployable Turnstile site key (`0x…`; Cloudflare test keys are
  refused) and no error-reporting DSN;
- has no Google sign-in: no Google Identity Services loader or call
  (`accounts.google.com`, `/gsi/client`, `google.accounts.id`) and no Google
  OAuth client id. Health-id inlines `VITE_HID_GOOGLE_CLIENT_ID` as a bare
  value where it is used, so these markers, which a build with it set always
  carries, are the check, not the variable's name;
- holds only `index.html` and content-hashed `.js`, `.css`, image and font
  files under `assets/`, with no source map, `sourceMappingURL`, service
  worker, web app manifest, symbolic link or credential-shaped value; and
- has an `index.html` that is exactly the shell Vite writes: the doctype;
  `html lang`; a head with `meta` charset (UTF-8), viewport and robots, the
  title, comments, one module entry script, and `modulepreload` and
  `stylesheet` links; and a body holding the root `div`. Every script and
  link must name a `.js` or `.css` file of the build's own `/assets/`. Any
  other element (`base`, `style`, `img`, `iframe`, `object`, `embed`,
  `noscript`, `template`, `svg` and so on), any other or repeated attribute
  (an `on*` handler, `http-equiv`, `data-*`), text outside the title, and
  markup it cannot parse exactly are refused. There is no edge CSP (see
  below), so this check is what keeps `index.html` to the build's own files.

It copies the build to `workers/<worker>/staged/<environment>/site`, checks
the copy again, and writes `provenance.json`: the Health-id repository,
application and source commit, the build command, the Worker, environment and
host, the inlined public environment record (the five keys of Health-id's
`src/publicEnvironment.ts`), every file's SHA-256 and size, and a tree hash.
The Health-id artefact has no `manifest.webmanifest` or `service-worker.js` by
design; `verify-config.mjs` requires those only of the legacy builds.

A new staging replaces the previous artefact only when the destination is
that artefact: exactly `site/` and a `provenance.json` of this schema, staged
for the same Worker and environment. It also stages into a missing or empty
directory. Any other destination, such as a mistyped `--staged-directory`, a
file, a symbolic link or another Worker's artefact, is refused and left
unchanged.

### Verification before a deployment

```sh
npm --prefix infra/cloudflare test
npm --prefix infra/cloudflare run verify                     # repository mode
npm --prefix infra/cloudflare run verify:launch:staging      # or :production
npm --prefix infra/cloudflare run dry-run:staging            # or :production
```

Repository mode (also run by the root `npm run verify`) checks every Worker
configuration and the launch manifest, and verifies any staged artefact that
is present; it needs the legacy application builds of the Workers that still
use them (`npm run build:cloudflare` at the root). CI's Cloudflare job runs
`npm --prefix infra/cloudflare test`, which covers the staging step, the
launch manifest and the dry-run wrapper with fixture builds.
`verify:launch:<environment>` checks every Worker configuration and the launch
manifest too, but not the legacy builds of the Workers the launch does not
deploy there, so a deployment checkout needs `npm ci` in `infra/cloudflare`
and the staged Health-id builds only. It requires a staged artefact for every
Health-id Worker deployed in that environment, and re-verifies each against
its provenance (hashes, host, environment, source commit) and the staging
rules. The dry-run scripts run that check first, then
Wrangler's build-only deployment check for the launch Workers of the
environment only. They do not publish a Worker or mutate DNS. Deploy only from
an authorized pipeline or operator session, one Worker at a time, with the
pinned local Wrangler:

```sh
infra/cloudflare/node_modules/.bin/wrangler deploy --env <environment> \
  --config infra/cloudflare/workers/<worker>/wrangler.json
```

Run `verify:launch:<environment>` immediately before each deployment, from the
same checkout and staged directory, so that what Wrangler uploads is the
verified artefact.

For a frontend rollback, restage the previous accepted Health-id commit's
build for that host, re-verify, and redeploy that Worker only.

## Environments and the Worker

Each Worker requires an explicit Wrangler named environment. `production` uses
the approved production hostname and the fixed
`https://api.healthidentitydirectory.com` origin; `staging` uses the paired
staging hostname and the fixed `https://api.staging.healthidentitydirectory.com`
origin. The Worker rejects any mismatched application, host, environment, or
origin combination, so browser input, Host headers, and query strings cannot
select an upstream. The `hid-ocr-redirect` Worker is a separate, originless
compatibility redirect from the old OCR hostname to the paired Migrate hostname
in each environment (not deployed at launch). Legacy Migrate `/migrate/*` and
OCR `/ocr/*` paths map once to root-equivalent Migrate paths; `/api/v1/*` paths
retain their API path. The production apex redirect is explicit and has no
staging counterpart because `staging.healthidentitydirectory.com` is the
staging web host.

Before proxying, the Worker deletes every inbound forwarding header
(`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and `Forwarded`) and sets
`X-Real-IP` to the address Cloudflare reported in `CF-Connecting-IP`, only when
that is one valid IPv4 or IPv6 address (IPv6 in canonical form). The AWS
gateway trusts that header only on connections from its VPC and, in staging
and production, refuses API requests without it. Every deployed Worker that
proxies `/api/v1` (at launch `hid-web` and `hid-admin`) must be deployed with
this behaviour before a gateway that requires it. A Worker built earlier
deletes the caller's `X-Real-IP` and sets none, so the gateway refuses its API
requests rather than trusting an address the caller chose.

The Worker sets `Cross-Origin-Opener-Policy`, `Referrer-Policy`,
`X-Content-Type-Options`, `X-Frame-Options: DENY` and a per-application
`Permissions-Policy`. It sets no Content Security Policy for any frontend;
Health-id loads only its own `/assets/` and the Turnstile script from
`challenges.cloudflare.com`, so none is needed for it to work. An edge CSP is
later hardening (ADR-052).

`ORIGIN_AUTH_TOKEN` is one secret binding in each named environment, but its
staging and production values must be generated and stored independently. It
must be installed with `wrangler secret put ORIGIN_AUTH_TOKEN --env <environment>`;
it must never be placed in `vars`, a frontend build, a command log, or this
repository. The Worker fails closed if the binding is absent or malformed.
Deployment also requires the account/zone identifiers through the authorized
environment. Hostinger remains registrar; Cloudflare becomes authoritative
DNS/TLS only after the separately approved nameserver cutover.

The legacy application Workers still build their own root-hosted artifact with
the corresponding `build:cloudflare:*` root script, and `verify-config.mjs`
keeps their checks (manifest scope, service worker, asset prefix), but they are
not deployed at launch.

The redirects are separate originless Workers because they serve no application
artifact. Their fixed 308 responses retain the path and query and never read a
redirect target from request input.
