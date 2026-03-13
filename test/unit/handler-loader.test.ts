import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRequestHandler, applyResponseHandler } from "../../src/handler-loader.js";
import type { Handler } from "../../src/types.js";

function makeRequest(url = "https://example.com/path"): Request {
  return new Request(url, { headers: { host: "example.com" } });
}

function makeResponse(body = "hello", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("applyRequestHandler", () => {
  it("passes through when handler has no onRequest", async () => {
    const handler: Handler = {};
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.strictEqual(result, req);
  });

  it("applies handler that adds a header", async () => {
    const handler: Handler = {
      onRequest: (req) => {
        const headers = new Headers(req.headers);
        headers.set("x-injected", "yes");
        return new Request(req, { headers });
      },
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.ok(result instanceof Request);
    assert.equal((result as Request).headers.get("x-injected"), "yes");
  });

  it("applies async handler", async () => {
    const handler: Handler = {
      onRequest: async (req) => {
        await new Promise((r) => setTimeout(r, 1));
        const headers = new Headers(req.headers);
        headers.set("x-async", "yes");
        return new Request(req, { headers });
      },
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.ok(result instanceof Request);
    assert.equal((result as Request).headers.get("x-async"), "yes");
  });

  it("returns original request when handler throws", async () => {
    const handler: Handler = {
      onRequest: () => {
        throw new Error("boom");
      },
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.strictEqual(result, req);
  });

  it("returns original request when async handler rejects", async () => {
    const handler: Handler = {
      onRequest: async () => {
        throw new Error("async boom");
      },
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.strictEqual(result, req);
  });

  it("preserves the original request body when a handler consumes and throws", async () => {
    const handler: Handler = {
      onRequest: async (req) => {
        await req.text();
        throw new Error("boom after read");
      },
    };
    const req = new Request("https://example.com/upload", {
      method: "POST",
      body: "hello",
      duplex: "half",
    });

    const result = await applyRequestHandler(handler, req);

    assert.ok(result instanceof Request);
    assert.strictEqual(result, req);
    assert.equal(req.bodyUsed, false);
    assert.equal(await req.text(), "hello");
  });

  it("handler can change method and url", async () => {
    const handler: Handler = {
      onRequest: (req) =>
        new Request("https://other.com/new", {
          method: "POST",
          headers: req.headers,
        }),
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.ok(result instanceof Request);
    assert.equal((result as Request).method, "POST");
    assert.equal((result as Request).url, "https://other.com/new");
  });

  it("handler can short-circuit with a Response", async () => {
    const handler: Handler = {
      onRequest: () => new Response("blocked", { status: 403 }),
    };
    const req = makeRequest();
    const result = await applyRequestHandler(handler, req);
    assert.ok(result instanceof Response);
    assert.equal((result as Response).status, 403);
  });
});

describe("applyResponseHandler", () => {
  it("passes through when handler has no onResponse", async () => {
    const handler: Handler = {};
    const res = makeResponse();
    const req = makeRequest();
    const result = await applyResponseHandler(handler, res, req);
    assert.strictEqual(result, res);
  });

  it("applies handler that adds a header", async () => {
    const handler: Handler = {
      onResponse: (res) => {
        const headers = new Headers(res.headers);
        headers.set("x-tagged", "proxy");
        return new Response(res.body, { status: res.status, headers });
      },
    };
    const res = makeResponse();
    const req = makeRequest();
    const result = await applyResponseHandler(handler, res, req);
    assert.equal(result.headers.get("x-tagged"), "proxy");
  });

  it("handler can mutate body", async () => {
    const handler: Handler = {
      onResponse: (res) =>
        new Response("modified body", { status: res.status, headers: res.headers }),
    };
    const res = makeResponse("original");
    const req = makeRequest();
    const result = await applyResponseHandler(handler, res, req);
    assert.equal(await result.text(), "modified body");
  });

  it("handler can change status code", async () => {
    const handler: Handler = {
      onResponse: (res) =>
        new Response(res.body, { status: 201, headers: res.headers }),
    };
    const res = makeResponse();
    const req = makeRequest();
    const result = await applyResponseHandler(handler, res, req);
    assert.equal(result.status, 201);
  });

  it("returns original response when handler throws", async () => {
    const handler: Handler = {
      onResponse: () => {
        throw new Error("response boom");
      },
    };
    const res = makeResponse();
    const req = makeRequest();
    const result = await applyResponseHandler(handler, res, req);
    assert.strictEqual(result, res);
  });

  it("preserves the original response body when a handler consumes and throws", async () => {
    const handler: Handler = {
      onResponse: async (res) => {
        await res.text();
        throw new Error("response boom after read");
      },
    };
    const res = makeResponse("original");
    const req = makeRequest();

    const result = await applyResponseHandler(handler, res, req);

    assert.strictEqual(result, res);
    assert.equal(res.bodyUsed, false);
    assert.equal(await res.text(), "original");
  });
});
