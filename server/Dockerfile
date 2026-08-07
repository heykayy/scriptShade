FROM node:22-slim

WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --build=missing

COPY . .

# SQLite file lives here — mount a volume at this path to persist it
ENV DB_PATH=/app/data/data.db
RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "index.js"]
