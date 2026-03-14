/**
 * Inject GitHub credentials from the proxy's environment.
 * The agent container has no GitHub token — the proxy adds it.
 */

const { GH_TOKEN } = process.env;

export function onRequest(req: Request): Request | Response {
  const url = new URL(req.url);
  if (url.hostname !== "api.github.com") return req;

  const headers = new Headers(req.headers);
  headers.set("authorization", `token ${GH_TOKEN}`);

  console.log(`[handler] ${req.method} ${url.pathname}`);
  return new Request(req, { headers });
}
