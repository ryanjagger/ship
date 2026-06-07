# Use ECR Public Node.js image (Docker Hub is blocked in government environments)
FROM public.ecr.aws/docker/library/node:20-slim

# Set working directory
WORKDIR /app

# Disable SSL strict mode for government VPN environments (MUST be before any npm commands)
RUN npm config set strict-ssl false

# Install pnpm
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

# Copy package files for dependency installation
# sdk/ ships like shared/: the api consumes @ryanjagger/ship-sdk as a runtime
# workspace dependency (Fleet agent → /api/v1), so its package.json must be
# present for pnpm to link it and its dist for the import to resolve.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/
COPY sdk/package.json ./sdk/

# Install production dependencies only (ignore prepare scripts that require dev deps)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

# Copy pre-built dist directories (built locally before deployment)
COPY shared/dist/ ./shared/dist/
COPY sdk/dist/ ./sdk/dist/
COPY api/dist/ ./api/dist/

# Expose port
EXPOSE 80

# Set production environment
ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV PORT=80

# Start the application (run migrations first to ensure schema exists)
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
