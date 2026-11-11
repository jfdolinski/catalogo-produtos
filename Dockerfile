# Catálogo de produtos para o Easypanel. O banco é o PostgreSQL (DATABASE_URL); a pasta /app/data guarda as imagens
# e precisa ser um volume. Node 24: traz o node:sqlite, usado só na migração do banco antigo.
FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY assets ./assets

VOLUME /app/data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
