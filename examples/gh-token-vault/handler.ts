/**
 * Token Vault handler — optionally with DPoP validation.
 *
 * Uses jose for DPoP proof verification and openid-client for the
 * Token Vault exchange. No hand-rolled crypto.
 *
 * Without DPoP (default):
 *   GH_TOKEN = <auth0-jwt>
 *
 * With DPoP (ENABLE_DPOP=true):
 *   GH_TOKEN = <auth0-jwt>&<dpop-proof>
 *
 * This handler:
 *   1. Extracts the Auth0 token (and DPoP proof if enabled)
 *   2. Optionally validates the DPoP proof via jose
 *   3. Exchanges the Auth0 token for a GitHub token via Token Vault
 *   4. Swaps the Authorization header
 */

import * as jose from "jose";
import { createHash } from "node:crypto";
import * as client from "openid-client";

const {
  AUTH0_DOMAIN,
  AUTH0_RESOURCE_CLIENT_ID,
  AUTH0_RESOURCE_CLIENT_SECRET,
  AUTH0_CONNECTION = "github",
  ENABLE_DPOP,
} = process.env;

const useDPoP = ENABLE_DPOP === "true";

// Lazy-initialized OIDC discovery
let config: client.Configuration | null = null;

async function getConfig(): Promise<client.Configuration> {
  if (!config) {
    config = await client.discovery(
      new URL(`https://${AUTH0_DOMAIN}/`),
      AUTH0_RESOURCE_CLIENT_ID!,
      AUTH0_RESOURCE_CLIENT_SECRET!
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// DPoP validation via jose
// ---------------------------------------------------------------------------

async function validateDpop(
  accessToken: string,
  proofJwt: string
): Promise<boolean> {
  try {
    const { payload } = await jose.jwtVerify(proofJwt, jose.EmbeddedJWK, {
      typ: "dpop+jwt",
      maxTokenAge: 300,
    });

    // Verify ath (access token hash binding)
    if (payload.ath) {
      const hash = createHash("sha256")
        .update(accessToken)
        .digest("base64url");
      if (hash !== payload.ath) return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token Vault exchange via openid-client
// ---------------------------------------------------------------------------

const ghTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getGitHubToken(subjectToken: string): Promise<string> {
  const cached = ghTokenCache.get(subjectToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const oidc = await getConfig();

  const parameters = new URLSearchParams({
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type:
      "http://auth0.com/oauth/token-type/federated-connection-access-token",
    connection: AUTH0_CONNECTION!,
  });

  const result = await client.genericGrantRequest(
    oidc,
    "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
    parameters
  );

  ghTokenCache.set(subjectToken, {
    token: result.access_token!,
    expiresAt: Date.now() + ((result.expires_in ?? 3600) as number) * 1000,
  });

  console.log(
    `[handler] Token Vault: GitHub token (expires in ${result.expires_in}s)`
  );
  return result.access_token!;
}

// ---------------------------------------------------------------------------
// Request hook
// ---------------------------------------------------------------------------

export async function onRequest(req: Request): Promise<Request | Response> {
  const url = new URL(req.url);
  if (url.hostname !== "api.github.com") return req;

  const raw = (req.headers.get("authorization") || "").replace(
    /^token\s+/i,
    ""
  );

  let auth0Token: string;

  if (useDPoP) {
    const sep = raw.indexOf("&");
    if (sep === -1) {
      return new Response("Missing DPoP proof", { status: 401 });
    }
    auth0Token = raw.slice(0, sep);
    const proof = raw.slice(sep + 1);

    if (!(await validateDpop(auth0Token, proof))) {
      console.log(`[handler] DPoP validation failed for ${url.pathname}`);
      return new Response("Invalid DPoP proof", { status: 401 });
    }
  } else {
    auth0Token = raw;
  }

  const ghToken = await getGitHubToken(auth0Token);
  const headers = new Headers(req.headers);
  headers.set("authorization", `token ${ghToken}`);

  console.log(`[handler] ${req.method} ${url.pathname}${useDPoP ? " (DPoP valid)" : ""}`);
  return new Request(req, { headers });
}
