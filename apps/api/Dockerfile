# SPDX-License-Identifier: Apache-2.0
# Server image: single container serving API + web UI (secondary path; the
# primary end-user distribution is the Tauri desktop app).
FROM node:24-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json ./
RUN npm ci --no-audit --no-fund
RUN npm run build --workspace=@mvp/web

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY seed ./seed
COPY tsconfig.base.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm run build --workspace=@mvp/governance \
  && npm run build --workspace=@mvp/agent-runtime \
  && npm run build --workspace=@mvp/workflows \
  && npm run build --workspace=@mvp/api
# static web UI served by the API
COPY --from=webbuild /app/apps/web/out ./apps/web/out
RUN node ./scripts/embed-web.mjs || true
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
