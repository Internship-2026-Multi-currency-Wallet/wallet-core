# syntax=docker/dockerfile:1

# ---- build: install all dependencies and compile TypeScript ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- prod-deps: production dependencies only ----
FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: small image, non-root user ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
# Version reported by /health (CI passes the git SHA; empty = package.json version).
ARG APP_VERSION=
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1
# Run migrations separately (`npm run migrate`) or via the container command
# (compose and Dokploy use: npm run migrate && node dist/main.js).
CMD ["node", "dist/main.js"]
