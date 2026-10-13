# HID API gateway

This image is the regional API routing boundary behind the AWS public ALB and
WAF. It contains no frontend artifacts. Web, EHR, Lab, Pharmacy, OCR, Outreach,
and Admin are built and released independently through Cloudflare Workers
Static Assets.

Build from the repository root:

```bash
docker build -f gateway/Dockerfile -t hid/gateway:local .
```

The image renders `nginx.conf.template` with envsubst at start-up. Every
variable it uses has a local default in the Dockerfile, and the CDK sets each
one in AWS:

| Variable | Local default | AWS (CDK) | Meaning |
|---|---|---|---|
| `IDENTITY_API_UPSTREAM` and five other `*_API_UPSTREAM` | `http://<service>:<port>` | Cloud Map names | Owner of each `/api/v1/*` prefix |
| `GATEWAY_DNS_RESOLVER` | `127.0.0.11` (Docker DNS) | VPC CIDR base plus two | Resolver for the upstream names |
| `VPC_CIDR` | `127.0.0.1/32` | the VPC CIDR | Only peer range whose `X-HID-Client-IP` is trusted |
| `HID_REQUIRE_CLIENT_IP` | `false` | `true` (staging, production) | Refuse API requests without a client address |
| `HID_ENABLED_API_ROUTES` | `identity,ehr` | `identity,ehr` unless staging opts in | Modules whose routes are proxied |

Behaviour:

- Each location proxies to a variable (`$hid_upstream`), so nginx resolves the
  upstream name per request (answers cached for 10 s) instead of once at
  start-up. The gateway starts when a module's name does not resolve, follows
  task replacements without a restart, and answers `503 UPSTREAM_UNAVAILABLE`
  for a module with no task. The upstream values carry no URI part, so the
  client's request URI reaches the backend unchanged.
- The realip module takes the client address from `X-HID-Client-IP`, which
  the Cloudflare Worker sets from `CF-Connecting-IP`, only on connections from
  `VPC_CIDR`. The gateway sends that address as `X-Forwarded-For` and drops
  the raw header. When `HID_REQUIRE_CLIENT_IP` is anything but `false`, a
  proxied API request without a usable client address answers
  `403 CLIENT_ADDRESS_REQUIRED`.
- A module not named in `HID_ENABLED_API_ROUTES` answers
  `404 API_ROUTE_NOT_FOUND` before proxying. Identity owns `/api/v1/auth`,
  `/identity`, `/audit`, `/admin` and `/commercial`; `ehr`, `lab`,
  `pharmacy`, `ocr` and `outreach` own their prefixes.
- Service-to-service routes answer `404 API_ROUTE_NOT_FOUND` in any letter
  case or with a trailing slash: `/api/v1/auth/service-session`,
  `/api/v1/identity/service/*`, `/api/v1/identity/outreach/*`,
  `/api/v1/ehr/internal/*`, `/api/v1/lab/work-items/accept-ehr-order`,
  `/api/v1/lab/imports/from-ocr`,
  `/api/v1/pharmacy/work-items/accept-ehr-prescription` and
  `/api/v1/pharmacy/imports/from-ocr`. Callers use the private service names.

Notification API, Notification Worker, Event Dispatcher, and OCR Worker are
intentionally not browser-routed. The gateway overwrites forwarding headers at
its trust boundary, preserves Cookie, Origin, CSRF, and correlation evidence,
and returns bounded Problem Details for unavailable or unknown routes. Every
non-API path returns `API_ONLY_ORIGIN` with `Cache-Control: no-store`.

`scripts/tests/gateway-config.test.mjs` and `scripts/verify-container-platform.mjs`
check this configuration against a model of nginx
(`scripts/lib/nginx-config-model.mjs`); they do not run nginx. A running
gateway is staging acceptance evidence.

The image accepts no frontend configuration, workload tokens, database
credentials, provider secrets, or AWS credentials as build inputs.
