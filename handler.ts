/**
 * Example handler that injects a header into every proxied request
 * and tags every response.
 *
 * Edit this file to customize request/response mutations.
 * Changes are picked up automatically (hot-reload).
 */

export function onRequest(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("x-wormhole", "intercepted");
  console.log(`[handler] → ${req.method} ${req.url}`);
  return new Request(req, { headers });
}

export function onResponse(res: Response, req: Request): Response {
  const headers = new Headers(res.headers);
  headers.set("x-proxied-by", "wormhole");
  console.log(`[handler] ← ${res.status} ${req.url}`);
  return new Response(res.body, { status: res.status, headers });
}
