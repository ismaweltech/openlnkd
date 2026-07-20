# ── Build stage ──────────────────────────────────────────────────────────────
# Playwright's official image ships Node + Chromium + every OS dependency the
# browser needs. The tag MUST match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/
RUN npm run build

# Drop dev dependencies for the runtime image
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# SQLite database lives here — mount a volume to persist it across restarts
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3000

# HEADLESS must stay true inside a container (no display server)
ENV HEADLESS=true
ENV DATABASE_PATH=/app/data/openlnkd.db

CMD ["node", "dist/main.js"]
