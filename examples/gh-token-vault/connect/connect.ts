/**
 * Connected Accounts companion app.
 *
 * Hono + @auth0/hono + Tailwind CDN. Lets a user log in via Auth0
 * and link their GitHub account to Token Vault so agents can access
 * GitHub on their behalf.
 *
 * Pages:
 *   /                → landing (login) or dashboard (connect / connected)
 *   /connect         → start connected accounts flow → redirect to GitHub
 *   /connect/callback → complete the flow → redirect to dashboard
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { auth, requiresAuth } from "@auth0/auth0-hono";
import type { Context } from "hono";

const {
  AUTH0_DOMAIN,
  CONNECT_CLIENT_ID,
  CONNECT_CLIENT_SECRET,
  SESSION_SECRET = "change-me-to-at-least-32-characters!!",
  CONNECT_PORT = "3001",
  AUTH0_CONNECTION = "github",
} = process.env;

const app = new Hono();

app.use(
  auth({
    domain: AUTH0_DOMAIN!,
    clientID: CONNECT_CLIENT_ID!,
    clientSecret: CONNECT_CLIENT_SECRET!,
    baseURL: `http://localhost:${CONNECT_PORT}`,
    session: { secret: SESSION_SECRET },
    authRequired: false,
    authorizationParams: {
      audience: `https://${AUTH0_DOMAIN}/userinfo`,
      scope: "openid profile offline_access",
    },
  })
);

// ---------------------------------------------------------------------------
// Per-session state — keyed by Auth0 sid (session ID)
// ---------------------------------------------------------------------------

interface SessionState {
  meToken: string | null;
  meTokenExpiresAt: number;
  pendingAuthSession: string | null;
}

const sessions = new Map<string, SessionState>();

function getSessionState(sid: string): SessionState {
  let state = sessions.get(sid);
  if (!state) {
    state = { meToken: null, meTokenExpiresAt: 0, pendingAuthSession: null };
    sessions.set(sid, state);
  }
  return state;
}

// MRRT — exchange refresh token for My Account API token
async function getMyAccountToken(c: Context): Promise<string> {
  const session = await c.var.auth0Client!.getSession(c);
  const sid = session!.user!.sid as string;
  const state = getSessionState(sid);

  if (state.meToken && Date.now() < state.meTokenExpiresAt - 60_000) {
    return state.meToken;
  }

  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CONNECT_CLIENT_ID!,
      client_secret: CONNECT_CLIENT_SECRET!,
      refresh_token: session!.refreshToken!,
      audience: `https://${AUTH0_DOMAIN}/me/`,
      scope: "read:me:connected_accounts create:me:connected_accounts delete:me:connected_accounts",
    }),
  });

  if (!res.ok) throw new Error(`MRRT exchange: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { access_token: string; expires_in: number };
  state.meToken = data.access_token;
  state.meTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return data.access_token;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const GITHUB_SVG = `<svg class="mx-auto h-12 w-12 text-gray-900" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>`;

function page(title: string, card: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-4">
  <div class="max-w-sm w-full bg-white rounded-2xl shadow-lg p-8 text-center">
    ${card}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const session = await c.var.auth0Client?.getSession(c);

  // Not logged in → show login
  if (!session) {
    return c.html(
      page(
        "Connect GitHub",
        `${GITHUB_SVG}
      <h1 class="mt-6 text-2xl font-bold text-gray-900">Connect GitHub</h1>
      <p class="mt-2 text-gray-600">Link your GitHub account to Auth0 Token Vault so the agent can access GitHub on your behalf.</p>
      <a href="/auth/login" class="mt-8 inline-block w-full bg-gray-900 text-white rounded-lg px-6 py-3 font-medium hover:bg-gray-800 transition">
        Log in with Auth0
      </a>`
      )
    );
  }

  // Logged in → check connected accounts
  const user = session.user;
  let account: { id: string; connection: string } | undefined;

  try {
    const accessToken = await getMyAccountToken(c);
    const res = await fetch(
      `https://${AUTH0_DOMAIN}/me/v1/connected-accounts/accounts`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );
    if (res.ok) {
      const body = (await res.json()) as { accounts: Array<{ id: string; connection: string }> };
      account = body.accounts.find((a) => a.connection === AUTH0_CONNECTION);
    }
  } catch {
    // ignore — user will see "Connect GitHub" UI
  }

  if (account) {
    return c.html(
      page(
        "GitHub Connected",
        `<div class="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
        <svg class="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <h1 class="mt-6 text-2xl font-bold text-gray-900">GitHub Connected</h1>
      <p class="mt-2 text-gray-600">The agent can now access GitHub on your behalf via Token Vault.</p>
      <div class="mt-6 bg-gray-50 rounded-lg p-4 text-left">
        <p class="text-sm text-gray-500">Signed in as</p>
        <p class="font-medium text-gray-900">${user?.name || user?.email || "User"}</p>
      </div>
      <a href="/disconnect/${account.id}" class="mt-6 inline-block text-red-500 text-sm hover:text-red-700">Disconnect GitHub</a>
      <br>
      <a href="/auth/logout" class="mt-2 inline-block text-sm text-gray-500 hover:text-gray-700">Log out</a>`
      )
    );
  }

  // Logged in but GitHub not connected
  return c.html(
    page(
      "Connect GitHub",
      `${GITHUB_SVG}
    <h1 class="mt-6 text-2xl font-bold text-gray-900">Connect GitHub</h1>
    <p class="mt-2 text-sm text-gray-500">Signed in as <strong>${user?.name || user?.email}</strong></p>
    <p class="mt-4 text-gray-600">Link your GitHub account so the agent can access it via Token Vault.</p>
    <a href="/connect" class="mt-8 inline-block w-full bg-gray-900 text-white rounded-lg px-6 py-3 font-medium hover:bg-gray-800 transition">
      Connect GitHub Account
    </a>
    <a href="/auth/logout" class="mt-4 inline-block text-sm text-gray-500 hover:text-gray-700">Log out</a>`
    )
  );
});

app.get("/connect", requiresAuth(), async (c) => {
  const accessToken = await getMyAccountToken(c);

  const res = await fetch(
    `https://${AUTH0_DOMAIN}/me/v1/connected-accounts/connect`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        connection: AUTH0_CONNECTION,
        redirect_uri: `http://localhost:${CONNECT_PORT}/connect/callback`,
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return c.html(
      page(
        "Error",
        `<h1 class="text-xl font-bold text-red-600">Error</h1>
      <p class="mt-2 text-sm text-gray-600">${text}</p>
      <a href="/" class="mt-6 inline-block text-gray-900 font-medium hover:underline">&larr; Back</a>`
      )
    );
  }

  const data = (await res.json()) as {
    connect_uri: string;
    auth_session: string;
    connect_params: Record<string, string>;
  };
  const session = await c.var.auth0Client!.getSession(c);
  const state = getSessionState(session!.user!.sid as string);
  state.pendingAuthSession = data.auth_session;

  const params = new URLSearchParams(data.connect_params);
  return c.redirect(`${data.connect_uri}?${params}`);
});

app.get("/connect/callback", requiresAuth(), async (c) => {
  const connectCode = c.req.query("connect_code");
  const session = await c.var.auth0Client!.getSession(c);
  const state = getSessionState(session!.user!.sid as string);

  if (!connectCode || !state.pendingAuthSession) {
    return c.html(
      page(
        "Error",
        `<h1 class="text-xl font-bold text-red-600">Error</h1>
      <p class="mt-2 text-gray-600">Missing connect_code or session expired.</p>
      <a href="/" class="mt-6 inline-block text-gray-900 font-medium hover:underline">&larr; Try again</a>`
      )
    );
  }

  const accessToken = await getMyAccountToken(c);

  const res = await fetch(
    `https://${AUTH0_DOMAIN}/me/v1/connected-accounts/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        auth_session: state.pendingAuthSession,
        connect_code: connectCode,
        redirect_uri: `http://localhost:${CONNECT_PORT}/connect/callback`,
      }),
    }
  );

  state.pendingAuthSession = null;

  if (!res.ok) {
    const text = await res.text();
    return c.html(
      page(
        "Error",
        `<h1 class="text-xl font-bold text-red-600">Error</h1>
      <p class="mt-2 text-sm text-gray-600">${text}</p>
      <a href="/" class="mt-6 inline-block text-gray-900 font-medium hover:underline">&larr; Try again</a>`
      )
    );
  }

  return c.redirect("/");
});

app.get("/disconnect/:id", requiresAuth(), async (c) => {
  const accessToken = await getMyAccountToken(c);
  const id = c.req.param("id");

  const res = await fetch(
    `https://${AUTH0_DOMAIN}/me/v1/connected-accounts/${id}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return c.html(
      page(
        "Error",
        `<h1 class="text-xl font-bold text-red-600">Error</h1>
      <p class="mt-2 text-sm text-gray-600">${text}</p>
      <a href="/" class="mt-6 inline-block text-gray-900 font-medium hover:underline">&larr; Back</a>`
      )
    );
  }

  return c.redirect("/");
});

serve({ fetch: app.fetch, port: Number(CONNECT_PORT) }, () => {
  console.log(`[connect] http://localhost:${CONNECT_PORT}`);
});
