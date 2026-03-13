import { initCA } from "./cert-manager.js";

// Standalone script to generate the CA certificate.
// Called from entrypoint.sh before starting the proxy.
initCA();
console.log("[generate-ca] Done.");
