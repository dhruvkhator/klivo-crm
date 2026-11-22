import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callMethod, defineTool, LEAD_OR_DEAL, withProductTotals } from "./helpers.js";

/** Lead/deal/contact workflows that mirror buttons in the CRM UI. */
export function registerSalesTools(server: McpServer) {
  defineTool(
    server,
    "get_activities",
    {
      title: "Get timeline of a lead or deal",
      description:
        "Returns the full activity timeline of a lead or deal: field changes, status changes, emails, comments, calls, notes, tasks and attachments. Use it to summarize history or prepare for a meeting.",
      input: { name: z.string().describe("Lead or deal ID") },
      kind: "read",
    },
    async ({ name }, token) => {
      // The CRM returns an unlabeled tuple; name the parts so Claude reads them correctly.
      const res = await callMethod<unknown[]>(token, "crm.api.activities.get_activities", { name }, "GET");
      const [activities, calls, notes, tasks, attachments] = Array.isArray(res) ? res : [res];
      return { activities, calls, notes, tasks, attachments };
    },
  );

  defineTool(
    server,
    "create_deal",
    {
      title: "Create a deal",
      description:
        "Creates a deal the same way the CRM's New Deal form does: if no `contact` ID is given but first_name/last_name/email/mobile_no are, a contact is created; if no `organization` ID is given but organization_name is, an organization is created. Other deal fields (status, deal_value, expected_closure_date, deal_owner, source, territory, …) can be included.",
      input: { deal: z.record(z.string(), z.any()).describe("Deal fields") },
      kind: "write",
    },
    async ({ deal }, token) => ({
      deal: await callMethod(token, "crm.fcrm.doctype.crm_deal.crm_deal.create_deal", { doc: withProductTotals(deal) }),
    }),
  );

  defineTool(
    server,
    "convert_lead_to_deal",
    {
      title: "Convert lead to deal",
      description:
        'Converts a lead into a deal like the CRM\'s Convert button (creates deal + contact + organization). Optionally reuse an existing contact/organization, and pass extra deal fields in `deal`, e.g. {"deal_value": 50000, "status": "Qualification"}.',
      input: {
        lead: z.string().describe("Lead ID"),
        deal: z.record(z.string(), z.any()).optional(),
        existing_contact: z.string().optional().describe("Contact ID to link instead of creating one"),
        existing_organization: z.string().optional().describe("Organization ID to link instead of creating one"),
      },
      kind: "write",
    },
    async (args, token) => ({
      deal: await callMethod(token, "crm.fcrm.doctype.crm_lead.crm_lead.convert_to_deal", args),
    }),
  );

  defineTool(
    server,
    "get_deal_contacts",
    {
      title: "Get contacts of a deal",
      description: "Lists the contacts linked to a deal (with emails, phones and which one is primary).",
      input: { deal: z.string() },
      kind: "read",
    },
    async ({ deal }, token) => callMethod(token, "crm.fcrm.doctype.crm_deal.api.get_deal_contacts", { name: deal }, "GET"),
  );

  defineTool(
    server,
    "add_deal_contact",
    {
      title: "Link a contact to a deal",
      description: "Links an existing contact to a deal.",
      input: { deal: z.string(), contact: z.string().describe("Contact ID") },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.fcrm.doctype.crm_deal.crm_deal.add_contact", args),
  );

  defineTool(
    server,
    "remove_deal_contact",
    {
      title: "Unlink a contact from a deal",
      description: "Removes the link between a contact and a deal. The contact itself is NOT deleted.",
      input: { deal: z.string(), contact: z.string() },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.fcrm.doctype.crm_deal.crm_deal.remove_contact", args),
  );

  defineTool(
    server,
    "set_deal_primary_contact",
    {
      title: "Set a deal's primary contact",
      description: "Marks one of the deal's linked contacts as its primary contact.",
      input: { deal: z.string(), contact: z.string() },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.fcrm.doctype.crm_deal.crm_deal.set_primary_contact", args),
  );

  defineTool(
    server,
    "get_contact_deals",
    {
      title: "Get deals of a contact",
      description: "Lists the deals a contact is linked to.",
      input: { contact: z.string() },
      kind: "read",
    },
    async ({ contact }, token) => callMethod(token, "crm.api.contact.get_linked_deals", { contact }, "GET"),
  );

  defineTool(
    server,
    "add_contact_email_or_phone",
    {
      title: "Add an email or phone to a contact",
      description: "Adds another email address or phone number to an existing contact.",
      input: {
        contact: z.string(),
        field: z.enum(["email", "phone"]),
        value: z.string(),
      },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.api.contact.create_new", args),
  );

  defineTool(
    server,
    "set_contact_primary_email_or_phone",
    {
      title: "Set a contact's primary email or phone",
      description: "Marks one of a contact's existing emails or phone numbers as primary.",
      input: {
        contact: z.string(),
        field: z
          .enum(["email", "mobile_no", "phone"])
          .describe('"email", "mobile_no" (primary mobile) or "phone" (primary landline)'),
        value: z.string(),
      },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.api.contact.set_as_primary", args),
  );

  defineTool(
    server,
    "add_note",
    {
      title: "Add a note",
      description: "Adds a note to a lead or deal. Content may be plain text or simple HTML.",
      input: { reference_doctype: LEAD_OR_DEAL, reference_name: z.string(), title: z.string(), content: z.string() },
      kind: "write",
    },
    async ({ reference_doctype, reference_name, title, content }, token) =>
      callMethod(token, "frappe.client.insert", {
        doc: { doctype: "FCRM Note", title, content, reference_doctype, reference_docname: reference_name },
      }),
  );

  defineTool(
    server,
    "create_task",
    {
      title: "Create a task",
      description: "Creates a CRM task, optionally linked to a lead or deal and assigned to a user (email; see list_users).",
      input: {
        title: z.string(),
        description: z.string().optional(),
        status: z.enum(["Backlog", "Todo", "In Progress", "Done", "Canceled"]).default("Todo"),
        priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
        due_date: z.string().optional().describe('"YYYY-MM-DD HH:mm:ss" in the CRM timezone'),
        assigned_to: z.string().optional().describe("User email"),
        reference_doctype: LEAD_OR_DEAL.optional(),
        reference_name: z.string().optional().describe("Lead or deal ID"),
      },
      kind: "write",
    },
    async ({ reference_name, ...rest }, token) =>
      callMethod(token, "frappe.client.insert", {
        doc: { doctype: "CRM Task", ...rest, ...(reference_name ? { reference_docname: reference_name } : {}) },
      }),
  );

  defineTool(
    server,
    "get_call_log",
    {
      title: "Get a call log",
      description: "Fetches a call log with its caller/receiver details, linked lead/deal, notes and tasks.",
      input: { name: z.string().describe("Call log ID") },
      kind: "read",
    },
    async ({ name }, token) => callMethod(token, "crm.fcrm.doctype.crm_call_log.crm_call_log.get_call_log", { name }, "GET"),
  );

  defineTool(
    server,
    "create_lead_from_call_log",
    {
      title: "Create a lead from a call log",
      description: "Creates a lead from a call log (optionally with extra lead fields) and links the call to it.",
      input: { call_log: z.string(), lead_details: z.record(z.string(), z.any()).optional() },
      kind: "write",
    },
    async (args, token) =>
      callMethod(token, "crm.fcrm.doctype.crm_call_log.crm_call_log.create_lead_from_call_log", args),
  );
}
