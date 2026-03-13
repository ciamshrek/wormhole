import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { getRequestListener } from "@hono/node-server";
import { getSNICallback } from "./cert-manager.js";
import { applyOnRequest, applyOnResponse } from "./handler-loader.js";

const DEFAULT_PORT = parseIntegerEnv(process.env.MWH_PORT, 3129);
const DEFAULT_UPSTREAM_TIMEOUT = parseIntegerEnv(process.env.MWH_UPSTREAM_TIMEOUT, 30000);
const DEFAULT_FIRST_BYTE_TIMEOUT = parseIntegerEnv(process.env.MWH_FIRST_BYTE_TIMEOUT, 10000);

export interface ProxyServerOpts {
  port?: number;
  listenHost?: string;
  sniCallback?: (hostname: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
  onRequest?: (req: Request) => Promise<Request | Response>;
  onResponse?: (res: Response, req: Request) => Promise<Response>;
  upstreamTimeoutMs?: number;
  firstByteTimeoutMs?: number;
}

export interface ProxyServers {
  multiplexer: net.Server;
  https: https.Server;
  http: http.Server;
  /** Close all servers and destroy all active connections */
  closeAll(): Promise<void>;
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function removeHopByHopHeaders(headers: Headers): Headers {
  const connectionHeader = headers.get("connection");
  const connectionTokens = connectionHeader
    ? connectionHeader
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : [];

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  for (const header of connectionTokens) {
    headers.delete(header);
  }

  return headers;
}

export function normalizeUpstreamRequest(req: Request): Request {
  const headers = removeHopByHopHeaders(new Headers(req.headers));
  const targetUrl = new URL(req.url);

  headers.set("host", targetUrl.host);
  headers.delete("content-length");

  return new Request(req, { headers });
}

export async function proxyUpstreamRequest(
  req: Request,
  opts: { upstreamTimeoutMs: number; customFetch?: typeof fetch }
): Promise<Response> {
  const init: Parameters<typeof proxy>[1] = {
    raw: req,
    signal: AbortSignal.timeout(opts.upstreamTimeoutMs),
  };

  if (opts.customFetch) {
    init.customFetch = (request) => opts.customFetch!(request);
  }

  return proxy(req.url, {
    ...init,
  });
}

export function normalizeOutgoingResponse(res: Response): Response {
  const headers = removeHopByHopHeaders(new Headers(res.headers));
  headers.delete("content-length");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Create a Hono app that proxies requests upstream using the given default scheme.
 */
function createProxyApp(
  defaultScheme: "http" | "https",
  onRequest: (req: Request) => Promise<Request | Response>,
  onResponse: (res: Response, req: Request) => Promise<Response>,
  upstreamTimeoutMs: number
): Hono {
  const app = new Hono();

  app.all("*", async (c) => {
    const host = c.req.header("host") || new URL(c.req.url).hostname;
    const reqUrl = new URL(c.req.url);
    const upstreamUrl = `${defaultScheme}://${host}${reqUrl.pathname}${reqUrl.search}`;

    // Build upstream request with corrected URL
    const upstreamReq = new Request(upstreamUrl, c.req.raw);

    // Handler can transform request or short-circuit with a Response
    const result = await onRequest(upstreamReq);
    if (result instanceof Response) {
      return normalizeOutgoingResponse(result);
    }

    try {
      const proxiedReq = normalizeUpstreamRequest(result);
      const responseReq = proxiedReq.clone();

      const res = await proxyUpstreamRequest(proxiedReq, { upstreamTimeoutMs });
      const finalRes = await onResponse(res, responseReq);

      return normalizeOutgoingResponse(finalRes);
    } catch (err) {
      console.error("[proxy-server] Upstream error:", (err as Error).message);
      const status = (err as Error).name === "TimeoutError" ? 504 : 502;
      return new Response(`Upstream error: ${(err as Error).message}`, {
        status,
        headers: { "content-type": "text/plain" },
      });
    }
  });

  return app;
}

/**
 * Start the proxy: a TCP multiplexer that routes TLS vs plaintext to
 * internal HTTPS and HTTP servers respectively.
 */
export async function startProxyServer(opts?: ProxyServerOpts): Promise<ProxyServers> {
  const port = opts?.port ?? DEFAULT_PORT;
  const listenHost = opts?.listenHost;
  const sniCallback = opts?.sniCallback ?? getSNICallback();
  const onRequest = opts?.onRequest ?? applyOnRequest;
  const onResponse = opts?.onResponse ?? applyOnResponse;
  const upstreamTimeoutMs = opts?.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT;
  const firstByteTimeoutMs = opts?.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT;

  // Create HTTPS Hono app + server (listens on random localhost port)
  const httpsApp = createProxyApp("https", onRequest, onResponse, upstreamTimeoutMs);
  const httpsServer = https.createServer(
    {
      SNICallback: sniCallback,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
    },
    getRequestListener(httpsApp.fetch)
  );

  // Create HTTP Hono app + server (listens on random localhost port)
  const httpApp = createProxyApp("http", onRequest, onResponse, upstreamTimeoutMs);
  const httpServer = http.createServer(getRequestListener(httpApp.fetch));

  // Start internal servers on localhost-only random ports
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  const httpsPort = (httpsServer.address() as net.AddressInfo).port;
  const httpPort = (httpServer.address() as net.AddressInfo).port;

  console.log(`[proxy-server] Internal HTTPS server on 127.0.0.1:${httpsPort}`);
  console.log(`[proxy-server] Internal HTTP server on 127.0.0.1:${httpPort}`);

  // TCP multiplexer: peek first byte to detect TLS vs plaintext
  const activeSockets = new Set<net.Socket>();

  const multiplexer = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
    socket.setTimeout(firstByteTimeoutMs);
    socket.on("timeout", () => {
      console.warn("[multiplexer] Closing idle connection before first byte");
      socket.destroy();
    });

    socket.once("data", (firstChunk) => {
      socket.setTimeout(0);

      // TLS handshake record starts with content type 0x16
      const targetPort = firstChunk[0] === 0x16 ? httpsPort : httpPort;

      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        upstream.write(firstChunk);
        socket.pipe(upstream).pipe(socket);
      });

      activeSockets.add(upstream);
      upstream.on("close", () => activeSockets.delete(upstream));

      upstream.on("error", (err) => {
        console.error("[multiplexer] Upstream connection error:", err.message);
        socket.destroy();
      });
    });

    socket.on("error", (err) => {
      // Client disconnected before sending data — ignore
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error("[multiplexer] Socket error:", err.message);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    multiplexer.once("error", onError);

    const onListen = () => {
      multiplexer.off("error", onError);
      const address = multiplexer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Multiplexer did not return an address"));
        return;
      }
      const host = address.address.includes(":") ? `[${address.address}]` : address.address;
      console.log(`[proxy-server] Multiplexer listening on ${host}:${address.port}`);
      resolve();
    };

    if (listenHost) {
      multiplexer.listen(port, listenHost, onListen);
      return;
    }

    multiplexer.listen(port, onListen);
  });

  const closeAll = async () => {
    // Destroy all piped sockets on the multiplexer
    for (const s of activeSockets) {
      s.destroy();
    }
    activeSockets.clear();
    // Close all HTTP/HTTPS connections
    httpsServer.closeAllConnections();
    httpServer.closeAllConnections();
    // Close all servers
    await Promise.all([
      new Promise<void>((resolve) => multiplexer.close(() => resolve())),
      new Promise<void>((resolve) => httpsServer.close(() => resolve())),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]);
  };

  return { multiplexer, https: httpsServer, http: httpServer, closeAll };
}
