# HID API gateway

This image is the regional API routing boundary behind the AWS public ALB and
WAF. It contains no frontend artifacts. Web, EHR, Lab, Pharmacy, OCR, Outreach,
and Admin are built and released independently through Cloudflare Workers
Static Assets.

Build from the repository root:

```bash
docker build -f gateway/Dockerfile -t hid/gateway:local .
```

The default internal upstream names match the runtime inventory. A deployment
may override the six `*_API_UPSTREAM` variables. Notification API, Notification
Worker, Event Dispatcher, and OCR Worker are intentionally not browser-routed.
The gateway overwrites forwarding headers at its trust boundary, preserves
Cookie, Origin, CSRF, and correlation evidence, and returns bounded Problem
Details for unavailable or unknown routes. Every non-API path returns
`API_ONLY_ORIGIN` with `Cache-Control: no-store`.

The image accepts no frontend configuration, workload tokens, database
credentials, provider secrets, or AWS credentials as build inputs.
