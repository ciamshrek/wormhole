/**
 * Agent — authenticates with Auth0, spawns gh CLI.
 *
 * 1. Device Code flow (optionally with DPoP) → access token + MRRT
 * 2. MRRT → My Account API token → check if GitHub is connected
 * 3. If not connected, log companion app URL and poll until ready
 * 4. Pack token (+ DPoP proof if enabled) into GH_TOKEN → spawn gh
 *
 * Set ENABLE_DPOP=true to enable DPoP proof-of-possession binding.
 */

import { spawnSync } from "node:child_process";
import * as client from "openid-client";
import dpopProof, { generateKeyPair, type KeyPair } from "dpop";

const {
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_AUDIENCE,
  AUTH0_CONNECTION = "github",
  CONNECT_PORT = "3001",
  ENABLE_DPOP,
} = process.env;

const useDPoP = ENABLE_DPOP === "true";
let keys: KeyPair | null = null;
let dpopHandle: client.DPoPHandle | undefined;

// OIDC discovery
const config = await client.discovery(
  new URL(`https://${AUTH0_DOMAIN}/`),
  AUTH0_CLIENT_ID!
);

if (useDPoP) {
  keys = (await generateKeyPair("ES256")) as KeyPair;
  dpopHandle = client.getDPoPHandle(config, keys);
  console.log("[agent] DPoP enabled");
} else {
  console.log("[agent] DPoP disabled (set ENABLE_DPOP=true to enable)");
}

// ---------------------------------------------------------------------------
// 1. Device Code Flow → access token + MRRT
// ---------------------------------------------------------------------------

const deviceResponse = await client.initiateDeviceAuthorization(config, {
  scope: "openid offline_access",
  audience: AUTH0_AUDIENCE!,
});

console.log(`\n${"=".repeat(60)}`);
console.log(`  Authorize this agent:\n`);
console.log(`  ${deviceResponse.verification_uri_complete}`);
console.log(`  Code: ${deviceResponse.user_code}`);
console.log(`${"=".repeat(60)}\n`);

const tokenResponse = await client.pollDeviceAuthorizationGrant(
  config,
  deviceResponse,
  undefined,
  { DPoP: dpopHandle }
);

const token = tokenResponse.access_token;
const refreshToken = tokenResponse.refresh_token!;

console.log(`Authorized!${useDPoP ? " Token is DPoP-bound." : ""}\n`);

// ---------------------------------------------------------------------------
// 2. Connected Accounts — MRRT → My Account API
// ---------------------------------------------------------------------------

let meToken: string | null = null;
let meTokenExpiresAt = 0;

async function getMyAccountToken(): Promise<string> {
  if (meToken && Date.now() < meTokenExpiresAt - 60_000) return meToken;

  const meResponse = await client.refreshTokenGrant(config, refreshToken, {
    audience: `https://${AUTH0_DOMAIN}/me/`,
    scope: "read:me:connected_accounts",
  });

  meToken = meResponse.access_token;
  meTokenExpiresAt = Date.now() + (meResponse.expires_in ?? 3600) * 1000;
  return meToken!;
}

async function isGitHubConnected(): Promise<boolean> {
  try {
    const token = await getMyAccountToken();

    const res = await fetch(
      `https://${AUTH0_DOMAIN}/me/v1/connected-accounts/accounts`,
      { headers: { authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return false;
    const body = (await res.json()) as { accounts: Array<{ connection: string }> };
    return body.accounts.some((a) => a.connection === AUTH0_CONNECTION);
  } catch {
    return false;
  }
}

if (!(await isGitHubConnected())) {
  console.log(`${"=".repeat(60)}`);
  console.log(`  GitHub not connected. Open the companion app:\n`);
  console.log(`  http://localhost:${CONNECT_PORT}`);
  console.log(`${"=".repeat(60)}\n`);

  while (!(await isGitHubConnected())) {
    console.log("[agent] Trying again in 30s...");
    await new Promise((r) => setTimeout(r, 30000));
  }

  console.log("GitHub connected!\n");
}

// ---------------------------------------------------------------------------
// 3. Run gh with a fresh DPoP proof packed into GH_TOKEN
// ---------------------------------------------------------------------------

let nonce: string | undefined;

async function gh(args: string[]): Promise<void> {
  let ghToken: string;
  if (useDPoP && keys) {
    const proof = await dpopProof(keys, "https://api.github.com", "GET", nonce, token);
    ghToken = `${token}&${proof}`;
  } else {
    ghToken = token;
  }
  spawnSync("gh", args, {
    env: { ...process.env, GH_TOKEN: ghToken },
    stdio: "inherit",
  });
}

console.log("--- repos ---");
await gh(["repo", "list", "--limit", "5"]);

console.log("\n--- starred ---");
await gh(["api", "user/starred", "--jq", ".[:3] | .[].full_name"]);
