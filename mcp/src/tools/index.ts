import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAdminTools } from "./admin.js";
import { registerAutomationTools } from "./automation.js";
import { registerCommsTools } from "./comms.js";
import { registerImportTools } from "./imports.js";
import { registerRecordTools } from "./records.js";
import { registerSalesTools } from "./sales.js";
import { registerTeamTools } from "./team.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "klivo-crm", version: "2.0.0" },
    {
      instructions: [
        "Tools for KLIVO's Frappe CRM (v16), acting as the signed-in user with their permissions.",
        "Use `search` to find people/companies by name or phone, `get_activities` for a lead/deal's history, `describe_doctype` when unsure of field names. Record IDs look like CRM-LEAD-2026-00012 / CRM-DEAL-2026-00003.",
        "Cold-calling fields on leads/deals: call_attempts, last_called_on, next_callback, product_interest, import_batch, contact_origin; built-in lead_temperature (Hot/Warm/Cold), lead_score, linkedin.",
        "Two-step rule: anything that sends, deletes, imports or switches on an automation has a preview step (prepare_email, prepare_whatsapp, delete_preview, import_preview, prepare_flow_enable) that returns a token. Always show the preview to the user and wait for their explicit OK before the second step. Never contact leads with status 'Do Not Contact'.",
        "Sequences are Automation Flows: read get_automation_capabilities, create flows (saved disabled), test with trial_run_flow, then enable.",
      ].join("\n"),
    },
  );
  registerRecordTools(server);
  registerSalesTools(server);
  registerCommsTools(server);
  registerTeamTools(server);
  registerImportTools(server);
  registerAdminTools(server);
  registerAutomationTools(server);
  return server;
}
