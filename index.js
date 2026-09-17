import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;

function buildServer() {
  const server = new McpServer({
    name: "davenn-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      title: "Hello World",
      description: "Says hello, optionally to a specific name.",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name ?? "world"}!` }],
    }),
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode: a fresh server + transport per request, no session tracking.
app.post("/mcp", async (req, res) => {
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
app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (req, res) => {
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
  console.log(`hello-mcp-server listening on port ${PORT}`);
});
