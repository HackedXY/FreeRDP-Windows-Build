# ---- build du frontend ----
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- API + fichiers statiques ----
FROM node:22-alpine
ENV NODE_ENV=production STATIC_DIR=/app/public UPLOAD_DIR=/data/uploads TZ=Africa/Conakry
# Client PostgreSQL (pg_dump/pg_restore) et rclone pour le service de sauvegarde
RUN apk add --no-cache tzdata postgresql16-client rclone tar
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
# Jeu de démonstration exclu de l'image de production (garde-fou supplémentaire)
RUN rm -f src/db/demo.js
COPY --from=web /web/dist ./public
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["node", "src/server.js"]
