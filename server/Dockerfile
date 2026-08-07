FROM node:22-slim

WORKDIR /app

# @libsql/client is pure JavaScript — no native build tools needed
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8787
CMD ["node", "index.js"]
