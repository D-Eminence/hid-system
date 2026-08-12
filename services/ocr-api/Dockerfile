FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/ocr-api/package.json services/ocr-api/package-lock.json ./services/ocr-api/
RUN cd services/ocr-api && npm ci
COPY packages/api-client/src ./packages/api-client/src
RUN services/ocr-api/node_modules/.bin/tsc -p packages/api-client/tsconfig.json
COPY services/ocr-api/nest-cli.json services/ocr-api/tsconfig.json services/ocr-api/tsconfig.build.json ./services/ocr-api/
COPY services/ocr-api/src ./services/ocr-api/src
RUN cd services/ocr-api && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY packages/api-client/package.json packages/api-client/tsconfig.json ./packages/api-client/
COPY services/ocr-api/package.json services/ocr-api/package-lock.json ./services/ocr-api/
RUN cd services/ocr-api && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/api-client/dist ./packages/api-client/dist
COPY --from=build /app/services/ocr-api/dist ./services/ocr-api/dist
WORKDIR /app/services/ocr-api
USER node
EXPOSE 3005
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3005';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
