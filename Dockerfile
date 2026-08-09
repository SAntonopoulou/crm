# ── build ────────────────────────────────────────────────────────────
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

# ── production dependencies ─────────────────────────────────────────
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── runtime ─────────────────────────────────────────────────────────
FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r crm && useradd -r -g crm crm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY package.json ./
USER crm
EXPOSE 3000
# API replica by default; set JOBS_ENABLED=true for a worker replica.
CMD ["node", "dist/main.js"]
