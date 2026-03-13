/**
 * Test client that makes an HTTPS request to httpbin.org through the proxy
 * and verifies that handler.ts mutations were applied to a real external service.
 */

const TARGET = "https://httpbin.org/anything?test=wormhole";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest() {
  console.log(`[external-test] Testing proxy against real external service...`);
  console.log(`[external-test] Target: ${TARGET}`);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[external-test] Attempt ${attempt}/${MAX_RETRIES}...`);

      const res = await fetch(TARGET);
      const body = await res.json();

      console.log("[external-test] Response status:", res.status);
      console.log("[external-test] httpbin echoed headers:", JSON.stringify(body.headers, null, 2));

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

      console.log("[external-test] ALL CHECKS PASSED — real external HTTPS intercepted!");
      process.exit(0);
    } catch (err) {
      lastError = err as Error;
      console.log(`[external-test] Attempt ${attempt} failed:`, (err as Error).message);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  console.error("[external-test] FAILED after all retries:", lastError?.message);
  process.exit(1);
}

runTest();
