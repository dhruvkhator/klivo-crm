import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callMethod, defineTool, READ_DOCTYPES } from "./helpers.js";

const ASSIGNABLE = z.enum(["CRM Lead", "CRM Deal", "CRM Task"]);

const CHARTS = [
  "total_leads",
  "ongoing_deals",
  "average_ongoing_deal_value",
  "won_deals",
  "average_won_deal_value",
  "average_deal_value",
  "average_time_to_close_a_lead",
  "average_time_to_close_a_deal",
  "sales_trend",
  "forecasted_revenue",
  "funnel_conversion",
  "deals_by_stage_axis",
  "deals_by_stage_donut",
  "lost_deal_reasons",
  "leads_by_source",
  "deals_by_source",
  "deals_by_territory",
  "deals_by_salesperson",
] as const;

const dateRange = {
  from_date: z.string().optional().describe("YYYY-MM-DD; default first day of this month"),
  to_date: z.string().optional().describe("YYYY-MM-DD; default last day of this month"),
  user: z.string().optional().describe("Limit to one salesperson (email). Sales Users always see only their own."),
};

/** Users, assignments, notifications and dashboard analytics. */
export function registerTeamTools(server: McpServer) {
  defineTool(
    server,
    "list_users",
    {
      title: "List CRM users",
      description: "Lists active CRM users (name, email, role). Use to find someone to assign a lead, deal or task to.",
      kind: "read",
    },
    async (_a, token) => {
      // Returns [all_users, crm_users]; only CRM users (Sales User / Sales Manager / System Manager) are assignable.
      const [, crmUsers] = await callMethod<[any[], any[]]>(token, "crm.api.session.get_users", {}, "GET");
      return crmUsers.map((u) => ({ email: u.name, full_name: u.full_name, role: u.role, is_me: !!u.session_user }));
    },
  );

  defineTool(
    server,
    "get_assignees",
    {
      title: "Get assignees",
      description: "Shows who a lead, deal or task is assigned to.",
      input: { doctype: ASSIGNABLE, name: z.string() },
      kind: "read",
    },
    async ({ doctype, name }, token) => callMethod(token, "crm.api.doc.get_assigned_users", { doctype, name }, "GET"),
  );

  defineTool(
    server,
    "assign",
    {
      title: "Assign to users",
      description: "Assigns a lead, deal or task to one or more users (emails). They get a CRM notification.",
      input: {
        doctype: ASSIGNABLE,
        name: z.string(),
        users: z.array(z.string()).min(1).describe("User emails"),
        comment: z.string().optional().describe("Optional note for the assignee"),
      },
      kind: "write",
    },
    async ({ doctype, name, users, comment }, token) =>
      callMethod(token, "frappe.desk.form.assign_to.add", {
        doctype,
        name,
        assign_to: JSON.stringify(users),
        description: comment,
      }),
  );

  defineTool(
    server,
    "unassign",
    {
      title: "Remove assignees",
      description: "Removes users from a lead, deal or task assignment (nothing is deleted).",
      input: { doctype: ASSIGNABLE, name: z.string(), users: z.array(z.string()).min(1) },
      kind: "write",
    },
    async ({ doctype, name, users }, token) =>
      callMethod(token, "crm.api.doc.remove_assignments", { doctype, name, assignees: JSON.stringify(users) }),
  );

  defineTool(
    server,
    "get_notifications",
    {
      title: "Get my notifications",
      description: "Lists the signed-in user's CRM notifications (mentions, assignments, WhatsApp, …), newest first.",
      input: { unread_only: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(30) },
      kind: "read",
    },
    async ({ unread_only, limit }, token) => {
      const all = await callMethod<any[]>(token, "crm.api.notifications.get_notifications", {}, "GET");
      return all.filter((n) => !unread_only || !n.read).slice(0, limit);
    },
  );

  defineTool(
    server,
    "mark_notifications_read",
    {
      title: "Mark notifications read",
      description: "Marks all my notifications as read, or only those for one notification doc.",
      input: { doc: z.string().optional().describe("notification_type_doc to mark; omit for all") },
      kind: "write",
    },
    async ({ doc }, token) => callMethod(token, "crm.api.notifications.mark_as_read", { doc }),
  );

  defineTool(
    server,
    "get_dashboard",
    {
      title: "Get sales dashboard",
      description:
        "Returns the full CRM sales dashboard for a date range: totals for leads and deals, won deals, average values, time to close, sales trend, forecast, funnel, deals by stage/source/territory/salesperson, and lost reasons.",
      input: dateRange,
      kind: "read",
    },
    async (args, token) => callMethod(token, "crm.api.dashboard.get_dashboard", args, "GET"),
  );

  defineTool(
    server,
    "get_chart",
    {
      title: "Get one dashboard metric",
      description: "Returns a single dashboard metric/chart for a date range (cheaper than the full dashboard).",
      input: { chart: z.enum(CHARTS), ...dateRange },
      kind: "read",
    },
    async ({ chart, ...range }, token) =>
      callMethod(token, "crm.api.dashboard.get_chart", { name: chart, type: "", ...range }, "GET"),
  );

  defineTool(
    server,
    "list_doctypes",
    {
      title: "List available record types",
      description: "Lists the CRM record types these tools can read.",
      kind: "read",
    },
    async () => READ_DOCTYPES,
  );
}
