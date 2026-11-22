import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { frappeRequest } from "../frappe.js";
import { digitsOnly, looksLikePhone } from "../lib/normalize.js";
import {
  callMethod,
  defineTool,
  filtersSchema,
  READ_DOCTYPES,
  resourcePath,
  withProductTotals,
  WRITE_DOCTYPES,
} from "./helpers.js";

const STATUS_TYPES = ["Open", "Ongoing", "On Hold", "Won", "Lost"];

/** M7: keep status lists valid (allowed types, deal probability 0-100). */
function checkSettingsRecord(doctype: string, data: Record<string, any>) {
  const isStatus = doctype === "CRM Lead Status" || doctype === "CRM Deal Status";
  if (isStatus && data.type !== undefined && !STATUS_TYPES.includes(data.type)) {
    throw new Error(`type must be one of ${STATUS_TYPES.join(", ")}`);
  }
  if (doctype === "CRM Deal Status" && data.probability !== undefined && (data.probability < 0 || data.probability > 100)) {
    throw new Error("probability must be between 0 and 100");
  }
}

function prepareWrite(doctype: string, data: Record<string, any>) {
  checkSettingsRecord(doctype, data);
  return doctype === "CRM Deal" || doctype === "CRM Lead" ? withProductTotals(data) : data;
}

/** Generic record tools that work on any allowed CRM doctype. */
export function registerRecordTools(server: McpServer) {
  defineTool(
    server,
    "whoami",
    { title: "Who am I", description: "Returns the CRM user Claude is acting as.", kind: "read" },
    async (_args, token) => ({ user: await callMethod(token, "frappe.auth.get_logged_user", {}, "GET") }),
  );

  defineTool(
    server,
    "describe_doctype",
    {
      title: "Describe a CRM record type",
      description:
        "Lists all fields of a record type (field name, label, type, options, required, hidden/read-only flags), including custom fields such as call_attempts, last_called_on, next_callback, product_interest, import_batch, contact_origin. Call this before creating/updating records or writing filters if unsure of field names. For Link fields, list the linked doctype (e.g. CRM Lead Status) to see allowed values.",
      input: { doctype: z.enum(READ_DOCTYPES) },
      kind: "read",
    },
    async ({ doctype }, token) => {
      const res = await frappeRequest<{ docs: any[] }>(token, "GET", "/api/method/frappe.desk.form.load.getdoctype", {
        query: { doctype },
      });
      const skip = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Fold"]);
      const describe = (meta: any) =>
        (meta?.fields ?? [])
          .filter((f: any) => !skip.has(f.fieldtype))
          .map((f: any) => ({
            field: f.fieldname,
            label: f.label,
            type: f.fieldtype,
            ...(f.options ? { options: f.options } : {}),
            ...(f.reqd ? { required: true } : {}),
            ...(f.read_only ? { read_only: true } : {}),
            ...(f.hidden ? { hidden: true } : {}),
          }));
      const main = res.docs.find((d) => d.name === doctype) ?? res.docs[0];
      // Child tables (e.g. deal products, contact emails) come back as extra docs.
      const childTables = Object.fromEntries(
        res.docs.filter((d) => d !== main && d.istable).map((d) => [d.name, describe(d)]),
      );
      return { doctype, fields: describe(main), child_tables: childTables };
    },
  );

  defineTool(
    server,
    "list_records",
    {
      title: "List / filter CRM records",
      description:
        "Lists records of a type with filters, chosen fields, sorting and paging. Examples: leads by status, leads of an import batch (import_batch), callbacks due (next_callback), deals closing this month, notes/tasks/emails of a lead or deal (filter reference_doctype + reference_docname / reference_name), attachments (File with attached_to_doctype/attached_to_name), allowed status values. For more than 200 rows use export_records.",
      input: {
        doctype: z.enum(READ_DOCTYPES),
        filters: filtersSchema,
        or_filters: filtersSchema.describe("Same format as filters, but any one may match"),
        fields: z
          .array(z.string())
          .optional()
          .describe('Fields to return, e.g. ["name","lead_name","status","email"]. Default ["name","modified"].'),
        order_by: z.string().optional().describe('e.g. "modified desc" (default)'),
        limit: z.number().int().min(1).max(200).default(20),
        start: z.number().int().min(0).default(0).describe("Offset for paging"),
      },
      kind: "read",
    },
    async ({ doctype, filters, or_filters, fields, order_by, limit, start }, token) => {
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath(doctype), {
        query: {
          fields: JSON.stringify(fields?.length ? fields : ["name", "modified"]),
          filters: filters?.length ? JSON.stringify(filters) : undefined,
          or_filters: or_filters?.length ? JSON.stringify(or_filters) : undefined,
          order_by: order_by ?? "modified desc",
          limit_page_length: limit,
          limit_start: start,
        },
      });
      return { count: res.data.length, start, records: res.data };
    },
  );

  defineTool(
    server,
    "count_records",
    {
      title: "Count CRM records",
      description: "Counts records matching filters (e.g. how many leads were created this month).",
      input: { doctype: z.enum(READ_DOCTYPES), filters: filtersSchema },
      kind: "read",
    },
    async ({ doctype, filters }, token) => ({
      doctype,
      count: await callMethod(token, "frappe.client.get_count", { doctype, filters: filters ?? [] }, "GET"),
    }),
  );

  defineTool(
    server,
    "group_count",
    {
      title: "Group and count records",
      description:
        "Counts records grouped by one field, e.g. leads per status, deals per owner, leads per source or import_batch. Optional filters narrow the set first.",
      input: {
        doctype: z.enum(READ_DOCTYPES),
        group_by: z.string().describe("Field to group by, e.g. status, lead_owner, source"),
        filters: filtersSchema,
      },
      kind: "read",
    },
    async ({ doctype, group_by, filters }, token) => {
      if (!/^[a-z0-9_]+$/i.test(group_by)) throw new Error("group_by must be a plain field name");
      const rows = await callMethod<any[]>(
        token,
        "frappe.client.get_list",
        {
          doctype,
          fields: [group_by, "count(name) as count"],
          filters: filters ?? [],
          group_by,
          order_by: "count desc",
          limit_page_length: 500,
        },
        "GET",
      );
      return { doctype, group_by, groups: rows };
    },
  );

  defineTool(
    server,
    "search",
    {
      title: "Search the CRM",
      description:
        "Free-text search across leads, deals, contacts and organizations by name, email, phone or company. Phone numbers in any format (+91 98200 12345, 09820012345) are matched on their last 10 digits. Use this when the user mentions a person or company by name.",
      input: {
        text: z.string().min(2).describe("At least 2 characters"),
        limit_per_type: z.number().int().min(1).max(50).default(10),
      },
      kind: "read",
    },
    async ({ text, limit_per_type }, token) => {
      // Phones are stored in different formats; match on the trailing digits instead of the typed format.
      const like = looksLikePhone(text) ? `%${digitsOnly(text).slice(-10)}%` : `%${text}%`;
      const targets: Array<{ doctype: string; fields: string[]; search: string[] }> = [
        {
          doctype: "CRM Lead",
          fields: ["name", "lead_name", "organization", "email", "mobile_no", "status", "lead_owner"],
          search: ["lead_name", "first_name", "last_name", "organization", "email", "mobile_no", "phone"],
        },
        {
          doctype: "CRM Deal",
          fields: ["name", "organization", "lead_name", "email", "mobile_no", "status", "deal_value", "deal_owner"],
          search: ["name", "organization", "lead_name", "first_name", "last_name", "email", "mobile_no"],
        },
        {
          doctype: "Contact",
          fields: ["name", "full_name", "email_id", "mobile_no", "company_name"],
          search: ["full_name", "first_name", "last_name", "email_id", "mobile_no", "phone", "company_name"],
        },
        {
          doctype: "CRM Organization",
          fields: ["name", "organization_name", "website", "industry"],
          search: ["organization_name", "website"],
        },
      ];
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath(t.doctype), {
              query: {
                fields: JSON.stringify(t.fields),
                or_filters: JSON.stringify(t.search.map((f) => [f, "like", like])),
                order_by: "modified desc",
                limit_page_length: limit_per_type,
              },
            });
            return [t.doctype, res.data] as const;
          } catch (err) {
            return [t.doctype, { error: err instanceof Error ? err.message : String(err) }] as const;
          }
        }),
      );
      return Object.fromEntries(results);
    },
  );

  defineTool(
    server,
    "get_record",
    {
      title: "Get a CRM record",
      description: "Fetches one full record by its ID (e.g. CRM-LEAD-2026-00012), including child tables.",
      input: { doctype: z.enum(READ_DOCTYPES), name: z.string().describe("Record ID") },
      kind: "read",
    },
    async ({ doctype, name }, token) =>
      (await frappeRequest<{ data: unknown }>(token, "GET", resourcePath(doctype, name))).data,
  );

  defineTool(
    server,
    "create_record",
    {
      title: "Create a CRM record",
      description:
        "Creates a record with the given field values (see describe_doctype): lead, deal, contact, organization, note, task, product, or a settings-list entry: CRM Lead Status {lead_status, type: Open|Ongoing|On Hold|Won|Lost, color, position}, CRM Deal Status {deal_status, type, probability, color, position}, CRM Lead Source {source_name}, CRM Industry {industry}, CRM Territory {territory_name, parent_crm_territory}, CRM Lost Reason {lost_reason}. A CRM Lead needs first_name. Product line totals are calculated automatically. Prefer create_deal for deals, add_note for notes, create_task for tasks, create_email_template for templates.",
      input: { doctype: z.enum(WRITE_DOCTYPES), data: z.record(z.string(), z.any()).describe("Field values") },
      kind: "write",
    },
    async ({ doctype, data }, token) =>
      (await frappeRequest<{ data: unknown }>(token, "POST", resourcePath(doctype), { body: prepareWrite(doctype, data) })).data,
  );

  defineTool(
    server,
    "update_record",
    {
      title: "Update a CRM record",
      description:
        "Changes only the given fields of an existing record, e.g. a lead's status, call_attempts, last_called_on, next_callback, owner; a deal's value, stage, expected_closure_date, lost_reason; or a status's type/color/position. When passing `products`, send the full list (it replaces the table); totals are calculated automatically. Changing a status can start an automation flow (sequence).",
      input: {
        doctype: z.enum(WRITE_DOCTYPES),
        name: z.string().describe("Record ID"),
        data: z.record(z.string(), z.any()).describe("Fields to change"),
      },
      kind: "write",
    },
    async ({ doctype, name, data }, token) =>
      (await frappeRequest<{ data: unknown }>(token, "PUT", resourcePath(doctype, name), { body: prepareWrite(doctype, data) })).data,
  );

  defineTool(
    server,
    "get_linked_records",
    {
      title: "Get linked records",
      description:
        "Lists records linked to a given record (e.g. everything referencing a contact or organization). For an organization it also lists its contacts (the CRM links them through the contact's company_name).",
      input: { doctype: z.enum(READ_DOCTYPES), name: z.string() },
      kind: "read",
    },
    async ({ doctype, name }, token) => {
      const linked = await callMethod(token, "crm.api.doc.get_linked_docs_of_document", { doctype, docname: name }, "GET");
      if (doctype !== "CRM Organization") return linked;
      const contacts = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("Contact"), {
        query: {
          fields: JSON.stringify(["name", "full_name", "email_id", "mobile_no", "designation"]),
          filters: JSON.stringify([["company_name", "=", name]]),
          limit_page_length: 200,
        },
      });
      return { linked, contacts: contacts.data };
    },
  );
}
