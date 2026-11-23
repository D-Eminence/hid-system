# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01 AS configuration
COPY gateway/nginx.conf.template /tmp/default.conf.template
COPY gateway/proxy-headers.conf /tmp/hid-proxy-headers.conf

FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01 AS runtime
# Pin fixes from the base's signed Alpine 3.24 repository. Keep the existing
# unprivileged runtime and regex pin; fail if a reviewed package is unavailable.
# musl 1.2.6-r3 fixes CVE-2026-107891 (High; musl and musl-utils 1.2.6-r2 in the base).
# libxslt 1.1.43-r4 fixes CVE-2026-125350, CVE-2026-87636 and CVE-2026-9947
# (High; 1.1.43-r3 in the base, a dependency of the nginx xslt module).
# libxml2 2.13.9-r3 fixes CVE-2026-86144 (High; 2.13.9-r2 in the base, XInclude parse flags).
# nginx 1.30.7-r1 and its modules fix CVE-2026-113425, CVE-2026-121810,
# CVE-2026-123007, CVE-2026-123633, CVE-2026-123634 (Critical) and CVE-2026-118899
# (High) in the base's 1.30.6-r1. They come from the nginx.org Alpine 3.24 repository
# the base installed nginx from, verified by the nginx_signing.rsa.pub key the base
# already trusts; no nginx-unprivileged image with 1.30.7 is published yet. apk keeps
# the base's unprivileged nginx.conf and default.conf; drop the unused .apk-new copies.
USER 0
# curl is a base-image utility, unused by nginx, its entrypoint or our wget
# health check. Removing it also removes its unused libcurl dependency; no
# curl fix is available in this Alpine branch. Keep nginx modules installed.
RUN apk del --no-cache curl \
    && apk add --no-cache 'pcre2=10.49-r0' 'libexpat=2.10.0-r0' 'zlib=1.4-r0' 'libx11=1.8.14-r0' 'brotli-libs=1.2.1-r0' \
       'musl=1.2.6-r3' 'musl-utils=1.2.6-r3' 'libxslt=1.1.43-r4' 'libxml2=2.13.9-r3' \
    && apk add --no-cache -X https://nginx.org/packages/alpine/v3.24/main \
       'nginx=1.30.7-r1' 'nginx-module-njs=1.30.7.1.0.2-r1' 'nginx-module-xslt=1.30.7-r1' \
       'nginx-module-geoip=1.30.7-r1' 'nginx-module-image-filter=1.30.7-r1' \
    && rm -f /etc/nginx/nginx.conf.apk-new /etc/nginx/conf.d/default.conf.apk-new

ENV IDENTITY_API_UPSTREAM=http://identity-api:3001 \
    EHR_API_UPSTREAM=http://ehr-api:3002 \
    LAB_API_UPSTREAM=http://lab-api:3003 \
    PHARMACY_API_UPSTREAM=http://pharmacy-api:3004 \
    OCR_API_UPSTREAM=http://ocr-api:3005 \
    OUTREACH_API_UPSTREAM=http://outreach-api:3006 \
    SUPPORT_API_UPSTREAM=http://127.0.0.1:9 \
    GATEWAY_TRUSTED_PROXY_CIDR=127.0.0.1/32 \
    GATEWAY_DNS_RESOLVER=127.0.0.11
COPY --from=configuration /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=configuration /tmp/hid-proxy-headers.conf /etc/nginx/hid-proxy-headers.conf
USER 101
EXPOSE 3000
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/gateway-health/ready"]
CMD ["nginx", "-g", "daemon off;"]
