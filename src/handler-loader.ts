import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Handler } from "./types.js";

const HANDLER_PATH = path.resolve(process.env.MWH_HANDLER_PATH || "handler.ts");

let currentHandler: Handler = {};
let version = 0;

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    // Best-effort cleanup for tee'd streams; ignore cancellation failures.
  });
}

async function loadHandler(): Promise<void> {
  try {
    if (!fs.existsSync(HANDLER_PATH)) {
      console.log("[handler-loader] No handler found at", HANDLER_PATH, "- using passthrough");
      currentHandler = {};
      return;
    }

    version++;
    const moduleUrl = `${pathToFileURL(HANDLER_PATH).href}?v=${version}`;
    const module = await import(moduleUrl);
    const nextHandler: Handler = {};
    if (typeof module.onRequest === "function") {
      nextHandler.onRequest = module.onRequest;
    }
    if (typeof module.onResponse === "function") {
      nextHandler.onResponse = module.onResponse;
    }
    currentHandler = nextHandler;
    console.log("[handler-loader] Loaded handler from", HANDLER_PATH);
  } catch (err) {
    console.error("[handler-loader] Failed to load handler:", err);
    currentHandler = {};
  }
}

export async function initHandlerLoader(): Promise<void> {
  await loadHandler();

  // Use fs.watchFile (stat polling) instead of fs.watch (inotify).
  // fs.watch doesn't fire reliably on Docker bind mounts (especially Mac/Windows).
  const POLL_INTERVAL = parseIntegerEnv(process.env.MWH_WATCH_INTERVAL, 1000);
  fs.watchFile(HANDLER_PATH, { interval: POLL_INTERVAL }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log("[handler-loader] Detected change, reloading...");
      loadHandler().catch((err) =>
        console.error("[handler-loader] Reload failed:", err)
      );
    }
  });
  console.log("[handler-loader] Watching for changes to", HANDLER_PATH, `(polling every ${POLL_INTERVAL}ms)`);
}

/**
 * Apply an onRequest handler hook. Exported for direct testing with mock handlers.
 * Falls back to returning the original request if the hook is missing or throws.
 */
export async function applyRequestHandler(
  handler: Handler,
  req: Request
): Promise<Request | Response> {
  const hook = handler.onRequest;
  if (!hook) return req;
  const hookReq = req.clone();
  try {
    const result = await hook(hookReq);
    cancelBody(req.body);
    return result;
  } catch (err) {
    console.error("[handler-loader] onRequest error:", err);
    cancelBody(hookReq.body);
    return req;
  }
}

/**
 * Apply an onResponse handler hook. Exported for direct testing with mock handlers.
 * Falls back to returning the original response if the hook is missing or throws.
 */
export async function applyResponseHandler(
  handler: Handler,
  res: Response,
  req: Request
): Promise<Response> {
  const hook = handler.onResponse;
  if (!hook) return res;
  const hookRes = res.clone();
  try {
    const result = await hook(hookRes, req);
    cancelBody(res.body);
    return result;
  } catch (err) {
    console.error("[handler-loader] onResponse error:", err);
    cancelBody(hookRes.body);
    return res;
  }
}

export async function applyOnRequest(req: Request): Promise<Request | Response> {
  return applyRequestHandler(currentHandler, req);
}

export async function applyOnResponse(res: Response, req: Request): Promise<Response> {
  return applyResponseHandler(currentHandler, res, req);
}
