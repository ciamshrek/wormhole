/**
 * Test client that makes HTTPS and HTTP requests to httpbin.org through the
 * proxy and verifies that handler.ts mutations were applied.
 */

const HTTPS_URL = process.env.TARGET_URL || "https://httpbin.org/anything?test=wormhole";
const HTTP_URL = process.env.HTTP_TARGET_URL || "http://httpbin.org/anything?test=wormhole-http";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testRequest(url: string, label: string) {
  console.log(`[test-client] [${label}] Target: ${url}`);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[test-client] [${label}] Attempt ${attempt}/${MAX_RETRIES}...`);

      const res = await fetch(url);
      const body = await res.json();

      console.log(`[test-client] [${label}] Response status:`, res.status);
      console.log(`[test-client] [${label}] Echoed headers:`, JSON.stringify(body.headers, null, 2));

      // httpbin returns headers with title case keys
      const injected =
        body.headers?.["X-Wormhole"] ||
        body.headers?.["x-wormhole"];

      if (injected !== "intercepted") {
        throw new Error(
          `Expected x-wormhole: intercepted, got: ${injected}`
        );
      }

      const proxiedBy = res.headers.get("x-proxied-by");
      if (proxiedBy !== "wormhole") {
        throw new Error(
          `Expected x-proxied-by: wormhole, got: ${proxiedBy}`
        );
      }

      console.log(`[test-client] [${label}] Passed!`);
      return;
    } catch (err) {
      lastError = err as Error;
      const e = err as Error;
      console.log(`[test-client] [${label}] Attempt ${attempt} failed:`, e.message);
      if (e.cause) console.log(`[test-client] [${label}] Cause:`, e.cause);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`[${label}] FAILED after all retries: ${lastError?.message}`);
}

async function runTests() {
  console.log("[test-client] Testing proxy interception via httpbin.org...");

  await testRequest(HTTPS_URL, "HTTPS");
  await testRequest(HTTP_URL, "HTTP");

  console.log("[test-client] All checks passed!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("[test-client] FAILED:", err.message);
  process.exit(1);
});
