FROM node:24.13.0-bookworm-slim AS verify
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
COPY public ./public
COPY fixtures ./fixtures
RUN node scripts/check.js && node --test --test-concurrency=1 test/*.test.js

FROM node:24.13.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data
WORKDIR /app
COPY --from=verify --chown=node:node /app /app
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
