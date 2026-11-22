import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { config } from "./config.js";
import { frappeTokenVerifier, oauthMetadata } from "./auth.js";
import { buildServer } from "./tools/index.js";

const mcpUrl = new URL(`${config.publicUrl}/mcp`);
const publicHost = new URL(config.publicUrl).hostname;

// Host-header allowlist = DNS-rebinding protection; localhost is for the container healthcheck.
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: [publicHost, "localhost", "127.0.0.1"] });
app.set("trust proxy", 1); // behind Traefik

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Discovery documents that tell Claude where to log in (Frappe) and what this resource is.
app.use(
  mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: mcpUrl,
    scopesSupported: ["all"],
    resourceName: "KLIVO CRM",
  }),
);

const bearer = requireBearerAuth({
  verifier: frappeTokenVerifier,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

// Stateless Streamable HTTP: a fresh server + transport per request, nothing kept in memory between calls.
app.post("/mcp", bearer, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

// No server-initiated streams or sessions in stateless mode.
const notAllowed = (_req: unknown, res: import("express").Response) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", bearer, notAllowed);
app.delete("/mcp", bearer, notAllowed);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`KLIVO CRM MCP listening on :${config.port}  ->  ${mcpUrl.href}`);
});
