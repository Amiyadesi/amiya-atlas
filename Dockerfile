FROM node:24-bookworm-slim AS ui
WORKDIR /app
COPY package*.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
RUN npm ci --ignore-scripts
COPY src src
COPY public public
COPY index.html vite.config.ts tsconfig.json ./
RUN npm run build

FROM rust:1.99-bookworm AS core
WORKDIR /app
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs src-tauri/
COPY src-tauri/src src-tauri/src
COPY --from=ui /app/dist dist
RUN cargo build --manifest-path src-tauri/Cargo.toml --locked --no-default-features --features web-host --bin relakeep-web --release -j 1

FROM node:24-bookworm-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace @relakeep/server
COPY src src
COPY server server
RUN npm run build --workspace @relakeep/server && npm prune --omit=dev --workspace @relakeep/server

FROM node:24-bookworm-slim
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=backend /app/node_modules node_modules
COPY --from=backend /app/server/dist/selfhost.js ./selfhost.js
COPY --from=core /app/src-tauri/target/release/relakeep-web /usr/local/bin/relakeep-web
COPY --from=ui /app/dist ./ui
RUN sed -i 's/<html/<html data-relakeep-host data-relakeep-selfhost/' ui/index.html
ENV RELAKEEP_DATA_DIR=/data NODE_ENV=production
USER node
VOLUME /data
EXPOSE 5011
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:5011/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "selfhost.js"]
