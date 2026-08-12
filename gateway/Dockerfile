# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged:1.27-alpine AS configuration
COPY gateway/nginx.conf.template /tmp/default.conf.template
COPY gateway/proxy-headers.conf /tmp/hid-proxy-headers.conf

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV IDENTITY_API_UPSTREAM=http://identity-api:3001 \
    EHR_API_UPSTREAM=http://ehr-api:3002 \
    LAB_API_UPSTREAM=http://lab-api:3003 \
    PHARMACY_API_UPSTREAM=http://pharmacy-api:3004 \
    OCR_API_UPSTREAM=http://ocr-api:3005 \
    OUTREACH_API_UPSTREAM=http://outreach-api:3006
COPY --from=configuration /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=configuration /tmp/hid-proxy-headers.conf /etc/nginx/hid-proxy-headers.conf
USER 101
EXPOSE 3000
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/gateway-health/ready"]
CMD ["nginx", "-g", "daemon off;"]
