FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/api-client ./packages/api-client
COPY services/ehr-api/package.json services/ehr-api/package-lock.json ./services/ehr-api/
RUN cd services/ehr-api && npm ci
RUN services/ehr-api/node_modules/.bin/tsc -p packages/api-client/tsconfig.json
COPY services/ehr-api/nest-cli.json services/ehr-api/tsconfig.json services/ehr-api/tsconfig.build.json ./services/ehr-api/
COPY services/ehr-api/src ./services/ehr-api/src
RUN cd services/ehr-api && npm run build

FROM node:22-bookworm-slim AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/ehr-api/package.json services/ehr-api/package-lock.json ./services/ehr-api/
RUN cd services/ehr-api && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/api-client/dist ./packages/api-client/dist

# Controlled deployment job target. APIs never race the central ledger at
# startup; an orchestrator may run this target once before rolling services.
FROM production-dependencies AS migration
COPY services/ehr-api/database ./services/ehr-api/database
COPY services/ehr-api/scripts ./services/ehr-api/scripts
WORKDIR /app/services/ehr-api
USER node
CMD ["node", "scripts/apply-migrations.mjs"]

FROM production-dependencies AS runtime
COPY --from=build /app/services/ehr-api/dist ./services/ehr-api/dist
WORKDIR /app/services/ehr-api
USER node
EXPOSE 3002
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3002';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
