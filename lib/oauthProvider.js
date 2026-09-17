import crypto from "node:crypto";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

// A single-user OAuth 2.1 authorization server for this MCP server. Combines
// the authorization server and resource server into one app (fine for a
// personal server), and gates the /authorize step behind the same secret
// used for direct bearer-token access (MCP_AUTH_TOKEN) instead of the SDK's
// demo provider, which auto-approves every request with no real login.
//
// Storage is in-memory only: codes, access tokens, and refresh tokens are
// lost on restart (Render free tier redeploys/sleeps). That just means the
// client has to redo the OAuth flow occasionally — not a security problem,
// just a UX one. Move to persistent storage later if that gets annoying.

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a || "");
  const bufB = Buffer.from(b || "");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function renderLoginPage(fields, error) {
  const hiddenInputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");

  return `<!doctype html>
<html>
<head><title>Sign in to davenn-mcp</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 380px; margin: 80px auto; padding: 0 16px; }
  input[type=password] { width: 100%; padding: 8px; font-size: 16px; box-sizing: border-box; }
  button { width: 100%; padding: 10px; font-size: 16px; margin-top: 12px; }
  .error { color: #b00020; margin-bottom: 12px; }
</style>
</head>
<body>
  <h2>Sign in to davenn-mcp</h2>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/oauth/login">
    ${hiddenInputs}
    <label for="token">Access token</label>
    <input type="password" id="token" name="token" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

export function createOAuthProvider() {
  const loginToken = process.env.MCP_AUTH_TOKEN;

  const clients = new Map();
  const codes = new Map(); // code -> { client, params, expiresAt }
  const accessTokens = new Map(); // token -> { clientId, scopes, expiresAt, resource }
  const refreshTokens = new Map(); // token -> { clientId, scopes, resource }

  function issueTokenPair(clientId, scopes = [], resource) {
    const accessToken = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;

    accessTokens.set(accessToken, { clientId, scopes, expiresAt, resource });
    refreshTokens.set(refreshToken, { clientId, scopes, resource });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  const provider = {
    clientsStore: {
      async getClient(clientId) {
        return clients.get(clientId);
      },
      async registerClient(clientMetadata) {
        clients.set(clientMetadata.client_id, clientMetadata);
        return clientMetadata;
      },
    },

    // Renders a real login form instead of auto-approving. The form posts
    // to /oauth/login (wired up separately in index.js), which is the only
    // place an authorization code actually gets issued.
    async authorize(client, params, res) {
      const fields = {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? "",
        scope: (params.scopes ?? []).join(" "),
        resource: params.resource ? params.resource.href : "",
      };
      res.status(200).set("Content-Type", "text/html").send(renderLoginPage(fields));
    },

    // Called by the /oauth/login route after the submitted token checks out.
    issueAuthorizationCode(client, params) {
      const code = crypto.randomUUID();
      codes.set(code, { client, params, expiresAt: Date.now() + CODE_TTL_MS });
      return code;
    },

    renderLoginPage,
    verifyLoginToken(token) {
      return Boolean(loginToken) && timingSafeEqualStr(token, loginToken);
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const entry = codes.get(authorizationCode);
      if (!entry || entry.expiresAt < Date.now()) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      if (entry.client.client_id !== client.client_id) {
        throw new InvalidGrantError("Authorization code was not issued to this client");
      }
      return entry.params.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      const entry = codes.get(authorizationCode);
      if (!entry || entry.expiresAt < Date.now()) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      if (entry.client.client_id !== client.client_id) {
        throw new InvalidGrantError("Authorization code was not issued to this client");
      }
      codes.delete(authorizationCode);
      return issueTokenPair(client.client_id, entry.params.scopes, entry.params.resource);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const entry = refreshTokens.get(refreshToken);
      if (!entry || entry.clientId !== client.client_id) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      refreshTokens.delete(refreshToken); // rotate on use
      return issueTokenPair(client.client_id, entry.scopes, entry.resource);
    },

    async verifyAccessToken(token) {
      if (loginToken && timingSafeEqualStr(token, loginToken)) {
        return {
          token,
          clientId: "static-token",
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        };
      }

      const entry = accessTokens.get(token);
      if (!entry || entry.expiresAt < Date.now()) {
        throw new InvalidTokenError("Invalid or expired access token");
      }
      return {
        token,
        clientId: entry.clientId,
        scopes: entry.scopes,
        expiresAt: Math.floor(entry.expiresAt / 1000),
        resource: entry.resource,
      };
    },

    async revokeToken(_client, request) {
      accessTokens.delete(request.token);
      refreshTokens.delete(request.token);
    },
  };

  return provider;
}
