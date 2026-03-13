import { initCA, getSNICallback } from "./cert-manager.js";
import { initHandlerLoader, applyOnRequest, applyOnResponse } from "./handler-loader.js";
import { startProxyServer } from "./proxy-server.js";

async function main() {
  console.log("[wormhole] Starting...");

  // Load CA (should already exist from entrypoint.sh, but init loads from disk)
  initCA();

  // Load handler.ts and start watching for changes
  await initHandlerLoader();

  // Start the proxy (multiplexer + HTTPS + HTTP servers)
  const servers = await startProxyServer({
    sniCallback: getSNICallback(),
    onRequest: applyOnRequest,
    onResponse: applyOnResponse,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[wormhole] Shutting down...");
    await servers.closeAll();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("[wormhole] Ready.");
}

main().catch((err) => {
  console.error("[wormhole] Fatal error:", err);
  process.exit(1);
});
