# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01 AS configuration
COPY gateway/nginx.conf.template /tmp/default.conf.template
COPY gateway/proxy-headers.conf /tmp/hid-proxy-headers.conf

FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01 AS runtime
# Pin fixes from the base's signed Alpine 3.24 repository. Keep the existing
# unprivileged runtime and regex pin; fail if a reviewed package is unavailable.
USER 0
# curl is a base-image utility, unused by nginx, its entrypoint or our wget
# health check. Removing it also removes its unused libcurl dependency; no
# curl fix is available in this Alpine branch. Keep nginx modules installed.
RUN apk del --no-cache curl \
    && apk add --no-cache 'pcre2=10.49-r0' 'libexpat=2.9.0-r0' 'zlib=1.3.2-r1' 'libx11=1.8.14-r0' 'brotli-libs=1.2.1-r0'

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
