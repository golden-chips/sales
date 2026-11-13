# GOLDEN ERP API — runs migrations on start, then the server (as the golden_app role).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force   # tsx (dev dependency) runs the TypeScript sources
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["sh", "-c", "./node_modules/.bin/tsx scripts/bootstrap.ts && exec ./node_modules/.bin/tsx src/server.ts"]
