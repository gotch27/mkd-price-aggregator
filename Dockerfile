FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
FROM dependencies AS worker
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . .
RUN mkdir -p /data/log-spool && chown -R node:node /data
ENV NODE_ENV=production
USER node
CMD ["npm","run","worker"]
FROM dependencies AS build
COPY . .
# Build-time values only satisfy validation; runtime must provide real secrets.
RUN node scripts/container-build.mjs
FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/config ./config
RUN mkdir -p /data/log-spool && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node","server.js"]
