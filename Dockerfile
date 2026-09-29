# syntax=docker/dockerfile:1
#
# The Company OS runtime image (Production Hosting, SI-77): ONE image for the two
# long-running processes, chosen by command.
#
#   worker   node engine/worker/main.ts            (default; no public port)
#   gateway  node engine/cli/whatsappGateway.ts    (Meta's webhook only)
#
# The frontend is not here: it is a static build served by the frontend host.
#
# - It defaults to DEPLOYMENT_ENVIRONMENT=production, so a deployed process is
#   held to the strictest start gate (engine/runtime/deploymentEnvironment.ts)
#   unless its deployment says "staging" on purpose.
# - It carries no environment file, signing key, schema or seed: .dockerignore
#   admits package*.json and engine/ (tests excluded) and nothing else. Every
#   secret arrives as a runtime environment variable from the platform's secret
#   store, never at build time.
# - It runs as the unprivileged `node` user.
# - The base image is pinned by digest; change it deliberately.

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only, exactly as locked; no lifecycle scripts run.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production \
    DEPLOYMENT_ENVIRONMENT=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY engine ./engine
USER node
CMD ["node", "engine/worker/main.ts"]
