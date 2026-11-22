function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value.replace(/\/+$/, "");
}

export const config = {
  /** Public base URL of this MCP server, e.g. https://mcp-crm.getklivo.com */
  publicUrl: required("PUBLIC_URL"),
  /** Public base URL of the Frappe CRM site, e.g. https://crm.getklivo.com */
  frappeUrl: required("FRAPPE_URL"),
  /** Client ID of the "Claude" OAuth Client created in Frappe. Tokens from any other client are rejected. */
  oauthClientId: required("OAUTH_CLIENT_ID"),
  port: Number(process.env.PORT ?? 8000),
};
