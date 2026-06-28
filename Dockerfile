FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app

# Install runtime deps first (cached unless package*.json change). The backend
# uses Fastify; the frontend stays dependency-free.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application sources.
COPY src ./src
COPY public ./public

# Persist config.json here; mount a volume in production. chown after npm ci so
# node_modules is owned by the non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
