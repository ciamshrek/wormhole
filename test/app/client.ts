/**
 * Test client that makes HTTPS and HTTP requests to the echo-server
 * through the proxy and verifies that handler.ts mutations were applied.
 */

const ECHO_URL = process.env.ECHO_URL || "https://echo-server/test-path?foo=bar";
const HTTP_ECHO_URL = process.env.HTTP_ECHO_URL || "http://echo-server/http-test?bar=baz";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 2000;

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
      console.log(`[test-client] [${label}] Echo body:`, JSON.stringify(body, null, 2));

      // Verify the proxy's handler injected the header
      const injectedHeader = body.headers?.["x-wormhole"];
      if (injectedHeader !== "intercepted") {
        throw new Error(
          `Expected x-wormhole: intercepted, got: ${injectedHeader}`
        );
      }

      // Verify response was tagged by the proxy
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
  console.log("[test-client] Testing proxy interception...");

  // Test 1: HTTPS interception
  await testRequest(ECHO_URL, "HTTPS");

  // Test 2: HTTP interception
  await testRequest(HTTP_ECHO_URL, "HTTP");

  console.log("[test-client] All checks passed!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("[test-client] FAILED:", err.message);
  process.exit(1);
});
