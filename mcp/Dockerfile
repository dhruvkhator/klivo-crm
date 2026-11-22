# Build stage: compile TypeScript, then drop dev dependencies
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: only compiled JS + production deps (~60-80 MB RAM at runtime)
FROM node:22-alpine
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "dist/index.js"]
