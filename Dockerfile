FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core/package.json         packages/core/
COPY packages/index-format/package.json packages/index-format/
COPY packages/etl/package.json          packages/etl/
COPY packages/api/package.json          packages/api/
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY . .

FROM base AS api
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--experimental-strip-types","packages/api/src/server.ts"]

FROM base AS etl
ENV NODE_ENV=production
ENTRYPOINT ["node","--experimental-strip-types","packages/etl/src/cli.ts"]
