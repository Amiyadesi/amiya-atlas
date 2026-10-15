FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace @relakeep/server
COPY src src
COPY server server
RUN npm run build --workspace @relakeep/server
RUN npm prune --omit=dev --workspace @relakeep/server
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends age ca-certificates && rm -rf /var/lib/apt/lists/* && ln -s /usr/bin/age /usr/local/bin/age
WORKDIR /app
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production PORT=4190 DATA_DIR=/data
USER node
EXPOSE 4190
CMD ["node","dist/app.js"]
