# Synchronous rendering gateway

This implementation is an opt-in replacement for the existing Node HTTP server. It keeps
`GET /screenshots?...&s=...` synchronous: the connection stays open until an image, timeout,
or capacity refusal is returned. It introduces no Redis dependency and no durable job queue.
The default Dockerfile builds this gateway; the original Node endpoint remains in source for compatibility testing. No production deployment credentials or workflows are included.

## Runtime

One container runs a Go gateway and a supervised Node/Puppeteer browser worker. Only the Go
port is exposed. The worker binds loopback and requires a generated, per-process bearer token.
The Go process drains requests on SIGTERM, then stops the worker. An unexpected worker exit
also terminates the gateway so the container can restart.

The gateway verifies HMAC-SHA256 using the existing URLSearchParams encoding rules, validates
render dimensions, and hashes the complete signed parameter set plus rendering version and
readiness policy. Signatures and source query strings are not logged. Unknown signed fields
remain part of the identity, including publication/group IDs and version stamps.

A fresh render uses a new isolated browser context. It retains the existing egress proxy,
internal-address restrictions, allowed internal hosts, browser launch recovery, user agent,
JPEG quality 95, viewport, crop, and height-cap behavior. Browser processes use Puppeteer-owned
temporary profiles instead of the existing /dev/null override, which falls back to a shared
Chromium profile and causes independent processes to collide. It closes the context when the last
caller disconnects or the deadline expires. A context that fails to close within five seconds
causes its browser to be killed, allowing recovery instead of leaking render capacity.

`RENDER_SLOTS` bounds active jobs per instance. `RENDER_PENDING` permits a small number of
additional unique jobs to wait within their HTTP requests. Identical in-flight requests share
one job and do not consume additional render slots. Canceling one caller does not cancel a
render still needed by another caller. Canceling the last caller cancels the job. Admission
counts remain reserved until the canceled job actually stops. Excess requests receive 503,
`Retry-After: 1`, and `Cache-Control: no-store`.

## Result storage

When RESULTS_BUCKET is configured, S3 is checked before render admission: stored images can
be streamed directly to the client while all render slots are occupied, without loading each
cached image into gateway memory. Fresh successful results are written to S3
before the shared job completes. Each lookup (through initial image validation) or write has a short independent timeout and one
SDK attempt. Streaming the remaining body uses the request deadline. Storage failures fall back to rendering; failures are never stored. There is no
cross-instance lease, so separate instances can occasionally render the same cold result.

Stored output is valid for at most CACHE_TTL_SECONDS. Hit responses advertise only its remaining
freshness, so an origin hit cannot grant a new full day to an aging result. RENDER_VERSION or
APP_REVISION is required with S3 to prevent reuse across rendering-code changes. Use a private
bucket with default encryption and a lifecycle rule to delete expired objects. The pod role
needs only s3:GetObject and s3:PutObject on the chosen prefix. Application credentials are not
baked into the image.

CloudFront continues to use the existing signed URLs. Confirm its screenshot cache policy
includes all output-affecting query parameters before rollout. This change does not create or
modify a distribution or bucket.

This preserves the existing one-day freshness model. It does not claim publication/group
timestamps cover every product, font, theme, or asset dependency. Longer immutable caching or
pre-generation requires that separate application dependency audit.

## Readiness

By default, rendering still uses networkidle0. TRUSTED_RENDER_HOSTS is an explicit comma-separated
list of exact hostnames. Only those hosts' `/dynamic_pages/`, `/adaptive_pages/`, and
`/content_templates/` routes use the optional faster asset-readiness policy. External URLs keep
networkidle0 even if their path resembles an internal render route.

Asset readiness waits for the load event, an optional `window.__publitasScreenshotReady` promise,
fonts, image decoding, and two animation frames. It repeats asset/layout readiness after a
height-cap viewport change. Revolution does not yet publish this promise: asynchronous widgets,
CSS animations, media, and customer-specific fonts need representative visual verification
before enabling a host. Leave the list empty for compatibility-first deployment.

## Running

```sh
export SCREENSHOT_SERVER_KEY='the-same-key-used-by-Revolution'
docker compose -f docker-compose.gateway.yml up --build
```

The new image copies only non-secret configuration; Go requires the signing key in the environment.
Use the existing egress settings (ALLOWED_INTERNAL_HOSTS, BLOCKED_HOSTS, INTERNAL_RANGES and
HOST_RESOLVER_RULES) as appropriate. Compose forwards HOST_RESOLVER_RULES; additional overrides
can be added to the deployment environment. The development compose file does not configure
AWS credentials: use your normal local credential injection or a pod role in Kubernetes.

For a source run, install the locked Node dependencies, build `gateway/cmd/screenshot-gateway`,
and run the binary from the repository root. Go 1.25+ and Node 22+ are required.

| Environment variable | Default | Meaning |
|---|---|---|
| SCREENSHOT_SERVER_KEY | required | Existing signed URL secret |
| PORT | 3001 | Public HTTP port |
| RENDERER_PORT | 3002 | Private loopback worker port |
| RENDER_SLOTS | 2 | Active unique jobs per instance; tune to pod resources |
| RENDER_PENDING | 8 | Additional admitted unique jobs |
| MAX_HTTP_REQUESTS | 256 | Concurrent screenshot requests, including shared waiters/cache reads |
| REQUEST_TIMEOUT_MS | 40000 | Request and admitted-job budget, including slot wait |
| CACHE_TIMEOUT_MS | 500 | Budget for each optional object-storage operation |
| CACHE_TTL_SECONDS | 86400 | Maximum stored output freshness, at most one day |
| RESULTS_BUCKET | empty | Enable S3 results when set |
| RESULTS_PREFIX | screenshots/v1/ | Object prefix |
| RENDER_VERSION | APP_REVISION | Output namespace; required with S3 |
| TRUSTED_RENDER_HOSTS | empty | Opt in selected internal routes to asset readiness |
| S3_FORCE_PATH_STYLE | false | For local S3-compatible integration testing |
| RENDERER_SCRIPT | renderer/index.js | Worker entrypoint relative to working directory |
| NODE_BINARY | node | Worker executable |

The worker retains a 30-second navigation limit and a 35-second total render deadline. Request
budgets above this do not extend the worker deadline. No wait/timeout query options are added:
Revolution's currently discarded wait_until/timeout options need a separate contract change.

`/ready` and `/healthcheck` report worker availability and drain state. `/live` checks worker
connectivity and triggers recovery if its browser disconnected. Reserve startup grace for Chrome
startup; use a 30-second termination grace. Saturated pods remain ready to serve cached images.
`/metrics` exposes counters and current HTTP/render admission occupancy in Prometheus format;
keep it internal at ingress. The worker retains AppSignal render spans, outcomes and launch
metrics. Go emits JSON logs for response status, result-cache status and total request duration.
Full gateway tracing and production dashboards remain rollout work.

## Verification and benchmark

```sh
cd gateway
go test -race ./...
go vet ./...
cd ..
npm ci
npm test
GATEWAY_BINARY=/absolute/path/to/screenshot-gateway npm run benchmark:gateway
```

The benchmark requires a real Chrome installation and uses local fixtures; no customer pages
are contacted. It compares a warm existing server with the gateway, verifies identical JPEG
bytes, measures fresh renders, verifies 24 identical concurrent misses navigate once, and
checks bounded refusal of a unique-request burst. Set RESULTS_BUCKET and normal AWS SDK
configuration to include stored-result measurements. For local object storage, AWS_ENDPOINT_URL_S3
and S3_FORCE_PATH_STYLE are supported. BENCH_OUTPUT writes the JSON result to a chosen file.

These local fixture results establish implementation behavior, not a production latency or
capacity guarantee. Before switching production traffic, run the same checks on representative
publication content and fonts, test the actual pod resource limits and AWS object store, audit
cache dependencies, then canary the image while observing p95/p99, error rates and memory.
