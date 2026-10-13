# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged@sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3 AS configuration
COPY gateway/nginx.conf.template /tmp/default.conf.template
COPY gateway/proxy-headers.conf /tmp/hid-proxy-headers.conf

FROM nginxinc/nginx-unprivileged@sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3 AS runtime
# Local defaults for every variable the template uses: envsubst leaves an
# undefined ${NAME} in the configuration. The CDK sets each one in AWS. Locally
# the resolver is Docker's embedded DNS, no hop is trusted for X-Real-IP,
# the client address is not required, and only the launch modules are routed.
ENV IDENTITY_API_UPSTREAM=http://identity-api:3001 \
    EHR_API_UPSTREAM=http://ehr-api:3002 \
    LAB_API_UPSTREAM=http://lab-api:3003 \
    PHARMACY_API_UPSTREAM=http://pharmacy-api:3004 \
    OCR_API_UPSTREAM=http://ocr-api:3005 \
    OUTREACH_API_UPSTREAM=http://outreach-api:3006 \
    GATEWAY_DNS_RESOLVER=127.0.0.11 \
    VPC_CIDR=127.0.0.1/32 \
    HID_REQUIRE_CLIENT_IP=false \
    HID_ENABLED_API_ROUTES=identity,ehr
COPY --from=configuration /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=configuration /tmp/hid-proxy-headers.conf /etc/nginx/hid-proxy-headers.conf
USER 101
EXPOSE 3000
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/gateway-health/ready"]
CMD ["nginx", "-g", "daemon off;"]
