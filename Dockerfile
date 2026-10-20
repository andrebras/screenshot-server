FROM golang:1.27.3-bookworm AS gateway-build
WORKDIR /build
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /screenshot-gateway ./cmd/screenshot-gateway

FROM node:22.11.0-bookworm AS node-build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22.11.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=gateway-build /screenshot-gateway /usr/local/bin/screenshot-gateway
COPY src/ ./src/
COPY renderer/ ./renderer/
COPY config/screenshot_server.yml config/appsignal.yml ./config/
RUN groupadd -g 1001 screenshotserver && useradd -r -m -u 1001 -g screenshotserver screenshotserver
USER screenshotserver
ENV PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ARG APP_REVISION
ENV APP_REVISION=$APP_REVISION
CMD ["screenshot-gateway"]
