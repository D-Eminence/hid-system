FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/outreach-api/package.json services/outreach-api/package-lock.json ./services/outreach-api/
RUN cd services/outreach-api && npm ci
COPY packages/api-client/src ./packages/api-client/src
RUN services/outreach-api/node_modules/.bin/tsc -p packages/api-client/tsconfig.json
COPY services/outreach-api/nest-cli.json services/outreach-api/tsconfig.json services/outreach-api/tsconfig.build.json ./services/outreach-api/
COPY services/outreach-api/src ./services/outreach-api/src
RUN cd services/outreach-api && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/outreach-api/package.json services/outreach-api/package-lock.json ./services/outreach-api/
RUN cd services/outreach-api && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/api-client/dist ./packages/api-client/dist
COPY --from=build /app/services/outreach-api/dist ./services/outreach-api/dist
WORKDIR /app/services/outreach-api
USER node
EXPOSE 3006
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3006';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
