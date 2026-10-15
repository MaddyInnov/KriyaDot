# SPDX-License-Identifier: Apache-2.0
# Server image: single container serving API + web UI (secondary path; the
# primary end-user distribution is the Tauri desktop app).
FROM node:22-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json ./
RUN npm ci --no-audit --no-fund
RUN npm run build --workspace=@mvp/web

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY seed ./seed
COPY scripts ./scripts
COPY tsconfig.base.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm run build --workspace=@mvp/governance \
  && npm run build --workspace=@mvp/agent-runtime \
  && npm run build --workspace=@mvp/redteam \
  && npm run build --workspace=@mvp/workflows \
  && npm run build --workspace=@mvp/run-health \
  && npm run build --workspace=@mvp/marketplace \
  && npm run build --workspace=@mvp/billing \
  && npm run build --workspace=@mvp/tenancy \
  && npm run build --workspace=@mvp/vault \
  && npm run build --workspace=@mvp/protocols \
  && npm run build --workspace=@mvp/voice \
  && npm run build --workspace=@mvp/muse-modules \
  && npm run build --workspace=@mvp/web \
  && npm run build --workspace=@mvp/api
# static web UI served by the API (built above, then embedded)
RUN node ./scripts/embed-web.mjs
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
