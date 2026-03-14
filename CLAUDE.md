# wormhole

Transparent HTTP/HTTPS proxy sidecar for Docker. Intercepts all outbound traffic from a container via iptables, runs it through user-defined `handler.ts` hooks, then forwards upstream.

## Stack

- **Runtime:** Node.js 22 + tsx (TypeScript execution, no build step)
- **Web framework:** Hono + `@hono/node-server`
- **Proxying:** `proxy()` from `hono/proxy` — handles hop-by-hop headers, content-encoding, body streaming
- **TLS:** `node:https` with SNICallback for dynamic per-domain certificate generation
- **Cert generation:** node-forge (CA + domain certs)
- **Testing:** `node:test` (built-in test runner, no extra deps)

## Architecture

```
entrypoint.sh          → creates UID 1337 user, generates CA, sets up iptables, starts proxy
src/index.ts           → wires cert-manager + handler-loader + proxy-server together
src/proxy-server.ts    → TCP multiplexer (0x16=TLS→HTTPS, else→HTTP), two Hono apps
src/cert-manager.ts    → CertManager class (CA init, per-domain cert cache with LRU eviction)
src/handler-loader.ts  → dynamic import of handler.ts with fs.watchFile hot-reload
src/sni-parser.ts      → pure function: extracts hostname from TLS ClientHello buffer
src/types.ts           → Handler interface (onRequest, onResponse)
```

The proxy runs as UID 1337. iptables redirects all non-DNS TCP from other UIDs to port 3129. The multiplexer peeks the first byte to route TLS vs plaintext to internal HTTPS/HTTP servers on localhost.

## Key Design Decisions

- **Standard Request/Response** — handler hooks use Web API `Request`/`Response`, not custom types
- **`onRequest` can return `Response`** — allows short-circuiting (blocking, mocking) without hitting upstream
- **Handler errors → passthrough** — if a hook throws, the original request/response proceeds unmodified
- **Body cloning** — handler-loader clones req/res before passing to hooks so the original body survives errors
- **`wormhole-ca-init.sh`** — shipped in the app-visible trust volume, installs the public CA into the system trust store + sets runtime env vars (NODE_OPTIONS, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE)

## Commands

```bash
npm test               # Unit tests (no Docker) — proxy, certs, handler, SNI
npm run test:docker    # Full E2E — iptables + proxy → httpbin.org
```

## Test Structure

- `test/unit/` — unit tests using `node:test`, run locally with real sockets (no Docker)
  - `proxy-server.test.ts` — HTTPS/HTTP proxying, error handling, multiplexer TLS detection
  - `handler-loader.test.ts` — hook application, error fallback, body preservation
  - `cert-manager.test.ts` — CA generation, domain certs, LRU cache, hostname validation
  - `sni-parser.test.ts` — ClientHello parsing, edge cases
- `test/app/` — Docker E2E test client, hits httpbin.org through the proxy
- Docker E2E verifies: iptables redirect works, handler mutations apply, both HTTP and HTTPS

## Important Notes

- The proxy container's system CA store is NOT updated (it doesn't need its own CA — it talks to real upstreams)
- `ca-certificates` package is not installed in the proxy image
- Healthcheck uses `nc -z 127.0.0.1 3129` — app containers use `depends_on: condition: service_healthy`
- `handler.ts` is bind-mounted read-only, hot-reloaded via `fs.watchFile` (polling, not inotify — works on Docker bind mounts)
- The app-visible trust volume contains only `ca.crt` + `wormhole-ca-init.sh`; the CA private key stays in the proxy-only state volume
