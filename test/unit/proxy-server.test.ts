import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";
import { CertManager } from "../../src/cert-manager.js";
import { startProxyServer, type ProxyServers } from "../../src/proxy-server.js";

// Allow self-signed certs for the entire integration test suite
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function closeHttpServer(server?: http.Server | https.Server): Promise<void> {
  if (!server) return Promise.resolve();
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("proxy-server HTTPS integration", () => {
  let echoServer: https.Server;
  let echoPort: number;
  let servers: ProxyServers;
  let proxyPort: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwh-integ-"));
    const certMgr = new CertManager({ caDir: tmpDir });
    certMgr.initCA();

    // Self-signed HTTPS echo server
    const echoKeys = forge.pki.rsa.generateKeyPair(2048);
    const echoCert = forge.pki.createCertificate();
    echoCert.publicKey = echoKeys.publicKey;
    echoCert.serialNumber = "01";
    echoCert.validity.notBefore = new Date();
    echoCert.validity.notAfter = new Date();
    echoCert.validity.notAfter.setFullYear(echoCert.validity.notBefore.getFullYear() + 1);
    echoCert.setSubject([{ name: "commonName", value: "localhost" }]);
    echoCert.setIssuer([{ name: "commonName", value: "localhost" }]);
    echoCert.setExtensions([
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ]);
    echoCert.sign(echoKeys.privateKey, forge.md.sha256.create());

    echoServer = https.createServer(
      {
        cert: forge.pki.certificateToPem(echoCert),
        key: forge.pki.privateKeyToPem(echoKeys.privateKey),
      },
      (req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            method: req.method,
            path: req.url,
            headers: req.headers,
            body: body || undefined,
          }));
        });
      }
    );
    await new Promise<void>((resolve) => echoServer.listen(0, resolve));
    echoPort = (echoServer.address() as any).port;

    servers = await startProxyServer({
      port: 0,
      sniCallback: certMgr.getSNICallback(),
      onRequest: async (req: Request) => {
        const url = new URL(req.url);
        const scheme = url.protocol.replace(":", "");
        const newUrl = `${scheme}://localhost:${echoPort}${url.pathname}${url.search}`;
        const headers = new Headers(req.headers);
        headers.set("x-wormhole", "intercepted");
        return new Request(newUrl, { method: req.method, headers, body: req.body, duplex: "half" } as any);
      },
      onResponse: async (res: Response, req: Request) => {
        const headers = new Headers(res.headers);
        headers.set("x-proxied-by", "wormhole");
        if (req.url.includes("/check-response-cookies")) {
          headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
          headers.append("set-cookie", "region=us; Path=/");
        }
        return new Response(res.body, { status: res.status, headers });
      },
      upstreamTimeoutMs: 5000,
    });
    proxyPort = (servers.multiplexer.address() as net.AddressInfo).port;
  });

  after(async () => {
    await servers?.closeAll();
    await closeHttpServer(echoServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function proxyFetchHttps(urlPath: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any; rawBody: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "localhost",
          port: proxyPort,
          path: urlPath,
          method: "GET",
          headers: { host: "test.example.com" },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: JSON.parse(data),
                rawBody: data,
              });
            } catch {
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: data,
                rawBody: data,
              });
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("proxies HTTPS request to upstream and returns response", async () => {
    const res = await proxyFetchHttps("/test-path?foo=bar");
    assert.equal(res.status, 200);
    assert.equal(res.body.method, "GET");
    assert.equal(res.body.path, "/test-path?foo=bar");
  });

  it("handler injected header is visible in upstream echo", async () => {
    const res = await proxyFetchHttps("/check-headers");
    assert.equal(res.body.headers["x-wormhole"], "intercepted");
  });

  it("response handler tags are visible in client response", async () => {
    const res = await proxyFetchHttps("/check-response");
    assert.equal(res.headers["x-proxied-by"], "wormhole");
  });

  it("preserves multiple set-cookie headers from the response handler", async () => {
    const res = await proxyFetchHttps("/check-response-cookies");
    assert.deepStrictEqual(res.headers["set-cookie"], [
      "session=abc; Path=/; HttpOnly",
      "region=us; Path=/",
    ]);
  });

});

describe("proxy-server HTTP integration", () => {
  let echoServer: http.Server;
  let echoPort: number;
  let servers: ProxyServers;
  let proxyPort: number;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwh-http-integ-"));
    const certMgr = new CertManager({ caDir: tmpDir });
    certMgr.initCA();

    // Plain HTTP echo server
    echoServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: body || undefined,
        }));
      });
    });
    await new Promise<void>((resolve) => echoServer.listen(0, resolve));
    echoPort = (echoServer.address() as any).port;

    servers = await startProxyServer({
      port: 0,
      sniCallback: certMgr.getSNICallback(),
      onRequest: async (req: Request) => {
        const url = new URL(req.url);
        const newUrl = `http://localhost:${echoPort}${url.pathname}${url.search}`;
        const headers = new Headers(req.headers);
        headers.set("x-wormhole", "intercepted");
        return new Request(newUrl, { method: req.method, headers, body: req.body, duplex: "half" } as any);
      },
      onResponse: async (res: Response) => {
        const headers = new Headers(res.headers);
        headers.set("x-proxied-by", "wormhole");
        return new Response(res.body, { status: res.status, headers });
      },
      upstreamTimeoutMs: 5000,
    });
    proxyPort = (servers.multiplexer.address() as net.AddressInfo).port;
  });

  after(async () => {
    await servers?.closeAll();
    await closeHttpServer(echoServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function proxyFetchHttp(urlPath: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any; rawBody: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "localhost",
          port: proxyPort,
          path: urlPath,
          method: "GET",
          headers: { host: "test.example.com" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: JSON.parse(data),
                rawBody: data,
              });
            } catch {
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: data,
                rawBody: data,
              });
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("proxies HTTP request to upstream and returns response", async () => {
    const res = await proxyFetchHttp("/test-path?foo=bar");
    assert.equal(res.status, 200);
    assert.equal(res.body.method, "GET");
    assert.equal(res.body.path, "/test-path?foo=bar");
  });

  it("handler injected header is visible in HTTP upstream echo", async () => {
    const res = await proxyFetchHttp("/check-headers");
    assert.equal(res.body.headers["x-wormhole"], "intercepted");
  });

  it("response handler tags are visible in HTTP client response", async () => {
    const res = await proxyFetchHttp("/check-response");
    assert.equal(res.headers["x-proxied-by"], "wormhole");
  });

  it("ctx.url uses http:// scheme for HTTP requests", async () => {
    const res = await proxyFetchHttp("/scheme-check");
    assert.equal(res.status, 200);
    assert.equal(res.body.method, "GET");
  });
});

describe("proxy-server error handling", () => {
  let tmpDir: string;
  let certMgr: CertManager;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwh-err-"));
    certMgr = new CertManager({ caDir: tmpDir });
    certMgr.initCA();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 502 when upstream is unreachable", async () => {
    const servers = await startProxyServer({
      port: 0,
      sniCallback: certMgr.getSNICallback(),
      onRequest: async (req: Request) => {
        return new Request("https://localhost:1/unreachable", {
          method: req.method,
          headers: req.headers,
        });
      },
      onResponse: async (res: Response) => res,
      upstreamTimeoutMs: 2000,
    });
    const port = (servers.multiplexer.address() as net.AddressInfo).port;

    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "localhost",
            port,
            path: "/fail",
            method: "GET",
            headers: { host: "unreachable.example.com" },
            rejectUnauthorized: false,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk: Buffer) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body: data }));
          }
        );
        req.on("error", reject);
        req.end();
      });

      assert.equal(res.status, 502);
      assert.ok(res.body.includes("Upstream error"));
    } finally {
      await servers.closeAll();
    }
  });

  it("returns 504 when upstream times out", async () => {
    // Server that never responds
    const hangServer = https.createServer(
      {
        cert: fs.readFileSync(path.join(tmpDir, "ca.crt")),
        key: fs.readFileSync(path.join(tmpDir, "ca.key")),
      },
      () => { /* intentionally never respond */ }
    );
    await new Promise<void>((resolve) => hangServer.listen(0, resolve));
    const hangPort = (hangServer.address() as any).port;

    const servers = await startProxyServer({
      port: 0,
      sniCallback: certMgr.getSNICallback(),
      onRequest: async (req: Request) => {
        return new Request(`https://localhost:${hangPort}/hang`, {
          method: req.method,
          headers: req.headers,
        });
      },
      onResponse: async (res: Response) => res,
      upstreamTimeoutMs: 500,
    });
    const port = (servers.multiplexer.address() as net.AddressInfo).port;

    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "localhost",
            port,
            path: "/timeout",
            method: "GET",
            headers: { host: "slow.example.com" },
            rejectUnauthorized: false,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk: Buffer) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body: data }));
          }
        );
        req.on("error", reject);
        req.end();
      });

      assert.equal(res.status, 504);
      assert.ok(res.body.includes("Upstream error"));
    } finally {
      await servers.closeAll();
      await closeHttpServer(hangServer);
    }
  });
});

describe("multiplexer TLS detection", () => {
  let tmpDir: string;
  let certMgr: CertManager;
  let servers: ProxyServers;
  let proxyPort: number;
  let httpsEchoPort: number;
  let httpEchoPort: number;
  let httpsEchoServer: https.Server;
  let httpEchoServer: http.Server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwh-mux-"));
    certMgr = new CertManager({ caDir: tmpDir });
    certMgr.initCA();

    // HTTPS echo server
    const echoKeys = forge.pki.rsa.generateKeyPair(2048);
    const echoCert = forge.pki.createCertificate();
    echoCert.publicKey = echoKeys.publicKey;
    echoCert.serialNumber = "01";
    echoCert.validity.notBefore = new Date();
    echoCert.validity.notAfter = new Date();
    echoCert.validity.notAfter.setFullYear(echoCert.validity.notBefore.getFullYear() + 1);
    echoCert.setSubject([{ name: "commonName", value: "localhost" }]);
    echoCert.setIssuer([{ name: "commonName", value: "localhost" }]);
    echoCert.setExtensions([
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ]);
    echoCert.sign(echoKeys.privateKey, forge.md.sha256.create());

    httpsEchoServer = https.createServer(
      {
        cert: forge.pki.certificateToPem(echoCert),
        key: forge.pki.privateKeyToPem(echoKeys.privateKey),
      },
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ proto: "https", path: req.url }));
      }
    );
    await new Promise<void>((resolve) => httpsEchoServer.listen(0, resolve));
    httpsEchoPort = (httpsEchoServer.address() as any).port;

    // HTTP echo server
    httpEchoServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proto: "http", path: req.url }));
    });
    await new Promise<void>((resolve) => httpEchoServer.listen(0, resolve));
    httpEchoPort = (httpEchoServer.address() as any).port;

    servers = await startProxyServer({
      port: 0,
      sniCallback: certMgr.getSNICallback(),
      onRequest: async (req: Request) => {
        const url = new URL(req.url);
        const scheme = url.protocol === "https:" ? "https" : "http";
        const echoPort = scheme === "https" ? httpsEchoPort : httpEchoPort;
        const newUrl = `${scheme}://localhost:${echoPort}${url.pathname}${url.search}`;
        return new Request(newUrl, { method: req.method, headers: req.headers, body: req.body, duplex: "half" } as any);
      },
      onResponse: async (res: Response) => res,
      upstreamTimeoutMs: 5000,
    });
    proxyPort = (servers.multiplexer.address() as net.AddressInfo).port;
  });

  after(async () => {
    await servers?.closeAll();
    await closeHttpServer(httpsEchoServer);
    await closeHttpServer(httpEchoServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes TLS connections to HTTPS server", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        {
          hostname: "localhost",
          port: proxyPort,
          path: "/tls-test",
          method: "GET",
          headers: { host: "tls.example.com" },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(res.proto, "https");
    assert.equal(res.path, "/tls-test");
  });

  it("routes plaintext connections to HTTP server", async () => {
    const res = await new Promise<any>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "localhost",
          port: proxyPort,
          path: "/plain-test",
          method: "GET",
          headers: { host: "plain.example.com" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(res.proto, "http");
    assert.equal(res.path, "/plain-test");
  });
});
