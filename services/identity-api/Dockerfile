FROM node:22-bookworm-slim AS build
WORKDIR /app/services/identity-api
COPY services/identity-api/package.json services/identity-api/package-lock.json ./
RUN npm ci
COPY services/identity-api/nest-cli.json services/identity-api/tsconfig.json services/identity-api/tsconfig.build.json ./
COPY services/identity-api/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app/services/identity-api
COPY services/identity-api/package.json services/identity-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# This runtime deliberately has no shell or package manager. The pinned Node 22
# Distroless image retains Debian 13 CA/TLS support while excluding the Node
# image's bundled npm tree and Debian packages that are not HID runtime needs.
FROM gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167 AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/identity-api
COPY --chown=65532:65532 --from=production-dependencies /app/services/identity-api/node_modules ./node_modules
COPY --chown=65532:65532 --from=build /app/services/identity-api/dist ./dist
USER 65532:65532
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port=process.env.PORT||'3001';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]
