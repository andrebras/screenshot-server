# Screenshot server

Synchronous screenshot service with a Go HTTP gateway and Node.js/Puppeteer/Chromium rendering.

- HMAC-signed screenshot URLs.
- Bounded rendering capacity and sharing of identical in-flight requests.
- Isolated browser contexts, cancellation, recovery, and graceful shutdown.
- Optional S3 result persistence with streaming cache-hit delivery.
- Network egress restrictions, render limits, health probes, and metrics.
- No Redis or durable job queue.

## Run

```sh
export SCREENSHOT_SERVER_KEY='your-signing-key'
docker compose -f docker-compose.gateway.yml up --build
```

The endpoint is `GET /screenshots?...&s=...` on port 3001. A request returns the image in the
same HTTP response. With Node dependencies installed, generate a URL using:

```sh
npm ci
npm run -s sign -- https://example.com viewportWidth=1200 viewportHeight=800
```

The signing key is required in the environment. Credentials are not included. AppSignal is
optional; configure `APPSIGNAL_API_KEY` for monitoring. S3 is disabled until `RESULTS_BUCKET`
is set; configure AWS credentials/role, region and `RENDER_VERSION` or `APP_REVISION` to enable it.

Internal addresses are blocked by default. Configure explicit `ALLOWED_INTERNAL_HOSTS` or
`HOST_RESOLVER_RULES` for render pages in your own network. Faster readiness is opt-in via
`TRUSTED_RENDER_HOSTS` and applies only to known internal render routes.

## Verify

```sh
cd gateway
go test -race ./...
go vet ./...
cd ..
npm ci
npm test
```

Go 1.25+ and Node 22+ are required for source development. Browser tests require Chrome;
`PUPPETEER_EXECUTABLE_PATH` can select an installed executable. The original Node HTTP endpoint
remains available for comparison; the container runs the Go gateway by default.

Read [the runtime, configuration and rollout guide](docs/synchronous-gateway.md).

## Initial measurements

Local Linux ARM64 Docker fixture test, two CPUs and 2 GiB memory, local S3-compatible storage:

| Case | Median |
| --- | ---: |
| Original endpoint, fresh render | 634.2 ms |
| Gateway, fresh render with opt-in asset readiness | 392.2 ms |
| Gateway, stored image | 1.4 ms |

Twenty-four identical simultaneous cold requests produced one page navigation. The fixture
image was byte-identical across implementations. See [the benchmark results](docs/benchmark-results.json). These small local samples are not production
latency or sustained-throughput guarantees and do not isolate the effect of Go.

Validation: 17 Go tests passed with race detection; 62 Node/browser tests passed. One inherited
AppSignal trace-export test also fails on the unchanged upstream code in the tested environment.
The non-root production image passed a smoke test under a one-CPU, 1-GiB limit.

Run `GATEWAY_BINARY=/absolute/path/to/screenshot-gateway npm run benchmark:gateway` to reproduce
the local fixture checks. Set `RESULTS_BUCKET` and AWS SDK configuration for stored-result tests.
