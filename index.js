import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { tools } from "./tools/index.js";
import { createOAuthProvider } from "./lib/oauthProvider.js";

const PORT = process.env.PORT || 3000;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL;

if (!MCP_AUTH_TOKEN) {
  console.error("MCP_AUTH_TOKEN is not set. Refusing to start.");
  process.exit(1);
}
if (!BASE_URL) {
  console.error("BASE_URL is not set (e.g. https://your-app.onrender.com). Refusing to start.");
  process.exit(1);
}

const issuerUrl = new URL(BASE_URL);
const resourceServerUrl = new URL("/mcp", BASE_URL);
const oauthProvider = createOAuthProvider();

function buildServer() {
  const server = new McpServer({
    name: "davenn-mcp",
    version: "1.0.0",
  });

  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }

  return server;
}

const requireAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
});

const app = express();

// Standard OAuth endpoints: /authorize, /token, /register, /revoke, and the
// .well-known metadata documents clients like Gemini use for discovery.
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ["mcp:tools"],
  }),
);

// The actual login gate: /authorize renders this form (see oauthProvider.js),
// which only issues an authorization code once the right token is submitted.
app.post("/oauth/login", express.urlencoded({ extended: false }), async (req, res) => {
  const { client_id, redirect_uri, code_challenge, state, scope, resource, token } = req.body;

  const client = await oauthProvider.clientsStore.getClient(client_id);
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send("Invalid client or redirect_uri.");
    return;
  }

  if (!oauthProvider.verifyLoginToken(token)) {
    res
      .status(401)
      .set("Content-Type", "text/html")
      .send(
        oauthProvider.renderLoginPage(
          { client_id, redirect_uri, code_challenge, state, scope, resource },
          "Incorrect token.",
        ),
      );
    return;
  }

  const code = oauthProvider.issueAuthorizationCode(client, {
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    state: state || undefined,
    scopes: scope ? scope.split(" ").filter(Boolean) : [],
    resource: resource ? new URL(resource) : undefined,
  });

  const target = new URL(redirect_uri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  res.redirect(302, target.href);
});

app.use(express.json());

// Stateless mode: a fresh server + transport per request, no session tracking.
app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support the SSE stream (GET) or session teardown (DELETE).
app.get("/mcp", requireAuth, (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", requireAuth, (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.get("/", (req, res) => {
  res.send("davenn-mcp is running. MCP endpoint: POST /mcp");
});

app.listen(PORT, () => {
  console.log(`davenn-mcp listening on port ${PORT}`);
});
