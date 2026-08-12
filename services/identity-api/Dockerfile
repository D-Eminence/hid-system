FROM node:22-bookworm-slim AS build
WORKDIR /app/services/identity-api
COPY services/identity-api/package.json services/identity-api/package-lock.json ./
RUN npm ci
COPY services/identity-api/nest-cli.json services/identity-api/tsconfig.json services/identity-api/tsconfig.build.json ./
COPY services/identity-api/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/services/identity-api
COPY services/identity-api/package.json services/identity-api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/services/identity-api/dist ./dist
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3001';fetch('http://127.0.0.1:'+port+'/api/v1/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
