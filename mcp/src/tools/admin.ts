import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { frappeRequest } from "../frappe.js";
import { consumeApproval, issueApproval } from "../lib/approvals.js";
import { toCsv } from "../lib/normalize.js";
import {
  callMethod,
  defineTool,
  DELETE_DOCTYPES,
  fetchAll,
  filtersSchema,
  READ_DOCTYPES,
  resourcePath,
  uploadFile,
} from "./helpers.js";

const MAX_DELETE = 1000;
const DELETE_TTL = 30 * 60;
/** Doctypes that carry an Import Batch tag. */
const BATCH_DOCTYPES = new Set(["CRM Lead", "CRM Deal"]);
/** Records the CRM's own bulk delete knows how to unlink/delete linked activity for. */
const CRM_BULK = new Set(["CRM Lead", "CRM Deal", "Contact", "CRM Organization"]);

interface DeletePlan {
  doctype: string;
  names: string[];
  linked_total: number;
}

/** Counts activity records hanging off leads/deals (notes, tasks, calls, comments, emails, files, deals from leads). */
async function countLinked(token: string, doctype: string, names: string[]) {
  if (!names.length || !(doctype === "CRM Lead" || doctype === "CRM Deal")) return {};
  const count = (dt: string, filters: unknown[]) =>
    callMethod<number>(token, "frappe.client.get_count", { doctype: dt, filters }, "GET").catch(() => 0);
  const inNames = (f: string) => [f, "in", names];
  const res: Record<string, number> = {
    notes: await count("FCRM Note", [inNames("reference_docname")]),
    tasks: await count("CRM Task", [inNames("reference_docname")]),
    call_logs: await count("CRM Call Log", [inNames("reference_docname")]),
    comments: await count("Comment", [["reference_doctype", "=", doctype], inNames("reference_name")]),
    emails: await count("Communication", [["reference_doctype", "=", doctype], inNames("reference_name")]),
    files: await count("File", [["attached_to_doctype", "=", doctype], inNames("attached_to_name")]),
  };
  if (doctype === "CRM Lead") res.deals_created_from_these_leads = await count("CRM Deal", [inNames("lead")]);
  return res;
}

/** Deletes, restore, custom fields, export and invites. */
export function registerAdminTools(server: McpServer) {
  defineTool(
    server,
    "delete_preview",
    {
      title: "Preview a delete (step 1 of 2)",
      description: `Lists exactly what would be deleted, by IDs, by filters, or by import batch, with counts of linked records (notes, tasks, calls, comments, emails, files, deals made from leads). Writes nothing. Returns a confirm_token. Show the summary to the user and wait for their explicit OK before delete_commit. At most ${MAX_DELETE} records per delete.`,
      input: {
        doctype: z.enum(DELETE_DOCTYPES),
        names: z.array(z.string()).optional(),
        filters: filtersSchema,
        import_batch: z.string().optional().describe("Delete every lead/deal tagged with this Import Batch"),
      },
      kind: "read",
    },
    async ({ doctype, names, filters, import_batch }, token, user) => {
      const f: unknown[] = [...(filters ?? [])];
      if (import_batch) {
        if (!BATCH_DOCTYPES.has(doctype)) throw new Error("import_batch only applies to CRM Lead / CRM Deal");
        f.push(["import_batch", "=", import_batch]);
      }
      if (!names?.length && !f.length) throw new Error("Give names, filters or import_batch. Deleting everything is not allowed.");
      if (names?.length) f.push(["name", "in", names]);
      const rows = await fetchAll<{ name: string }>(token, doctype, ["name"], f, MAX_DELETE + 1);
      if (!rows.length) return { matched: 0, note: "Nothing matches." };
      if (rows.length > MAX_DELETE) throw new Error(`More than ${MAX_DELETE} records match. Narrow it down or delete in parts.`);
      const ids = rows.map((r) => r.name);
      const missing = names?.filter((n) => !ids.includes(n)) ?? [];
      const linked = await countLinked(token, doctype, ids);
      const linkedTotal = Object.values(linked).reduce((a, b) => a + b, 0);
      const plan: DeletePlan = { doctype, names: ids, linked_total: linkedTotal };
      const t = issueApproval("delete", user, plan, DELETE_TTL);
      return {
        confirm_token: t.token,
        expires_at: t.expires_at,
        doctype,
        will_delete: ids.length,
        sample: ids.slice(0, 50),
        not_found_or_no_access: missing,
        linked_records: linked,
        next: "Show this to the user. After an explicit OK call delete_commit with confirm_token and linked = delete | unlink | block.",
      };
    },
  );

  defineTool(
    server,
    "delete_commit",
    {
      title: "Delete records (step 2 of 2)",
      description:
        "Deletes exactly the records from a delete_preview. linked: 'delete' also deletes their notes/tasks/call logs; 'unlink' keeps those but removes the link; 'block' refuses if any linked records exist. Deleted records can be restored with restore_deleted. Only after the user approved the preview.",
      input: { confirm_token: z.string(), linked: z.enum(["delete", "unlink", "block"]).default("block") },
      kind: "delete",
    },
    async ({ confirm_token, linked }, token, user) => {
      const plan = consumeApproval<DeletePlan>(confirm_token, "delete", user);
      if (linked === "block" && plan.linked_total > 0) {
        throw new Error(`${plan.linked_total} linked records exist. Choose linked = delete or unlink (run delete_preview again).`);
      }
      console.log(`[delete] ${user} deleting ${plan.names.length} ${plan.doctype} (linked=${linked})`);
      if (CRM_BULK.has(plan.doctype)) {
        await callMethod(token, "crm.api.doc.delete_bulk_docs", {
          doctype: plan.doctype,
          items: JSON.stringify(plan.names),
          delete_linked: linked === "delete",
        });
        return {
          doctype: plan.doctype,
          requested: plan.names.length,
          note:
            plan.names.length > 10
              ? "More than 10 records: the CRM deletes them in a background job (usually under a minute). Check with count_records."
              : "Deleted.",
        };
      }
      const failed: { name: string; error: string }[] = [];
      let deleted = 0;
      for (const name of plan.names) {
        try {
          await frappeRequest(token, "DELETE", resourcePath(plan.doctype, name));
          deleted++;
        } catch (err) {
          failed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { doctype: plan.doctype, deleted, failed };
    },
  );

  defineTool(
    server,
    "restore_deleted",
    {
      title: "Restore a deleted record",
      description:
        "Undoes a delete. Without deleted_document, lists recently deleted records (optionally of one type) with their Deleted Document IDs; with it, restores that record.",
      input: {
        deleted_document: z.string().optional().describe("Deleted Document ID from the list"),
        doctype: z.string().optional().describe("Filter the list, e.g. CRM Lead"),
        limit: z.number().int().min(1).max(200).default(30),
      },
      kind: "write",
    },
    async ({ deleted_document, doctype, limit }, token) => {
      if (deleted_document) {
        await callMethod(token, "frappe.core.doctype.deleted_document.deleted_document.restore", { name: deleted_document, alert: false });
        return { restored: deleted_document };
      }
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("Deleted Document"), {
        query: {
          fields: JSON.stringify(["name", "deleted_doctype", "deleted_name", "owner", "creation", "restored"]),
          filters: JSON.stringify([["restored", "=", 0], ...(doctype ? [["deleted_doctype", "=", doctype]] : [])]),
          order_by: "creation desc",
          limit_page_length: limit,
        },
      });
      return res.data;
    },
  );

  defineTool(
    server,
    "export_records",
    {
      title: "Export records to CSV",
      description:
        "Writes all records matching filters (no 200-row limit) to a private CSV file in the CRM and returns its download link (open it while logged in to the CRM).",
      input: {
        doctype: z.enum(READ_DOCTYPES),
        filters: filtersSchema,
        fields: z.array(z.string()).min(1).describe('e.g. ["name","lead_name","email","mobile_no","status"]'),
        file_name: z.string().optional(),
      },
      kind: "write",
    },
    async ({ doctype, filters, fields, file_name }, token) => {
      const rows = await fetchAll<Record<string, unknown>>(token, doctype, fields, filters ?? []);
      const name = file_name ?? `${doctype.replace(/\s+/g, "-")}-export-${new Date().toISOString().slice(0, 10)}.csv`;
      const f = await uploadFile(token, { name, content: Buffer.from(toCsv(rows, fields), "utf8"), isPrivate: true });
      return { rows: rows.length, file_id: f.name, download_url: `${config.frappeUrl}${f.file_url}` };
    },
  );

  defineTool(
    server,
    "create_custom_field",
    {
      title: "Add a custom field",
      description:
        "Admin only. Adds a field to a CRM record type and (by default) shows it in the CRM side panel. Field types: Data, Int, Select (options = values one per line), Date, Datetime, Check, Link (options = doctype). Use the same fieldname on CRM Lead and CRM Deal so lead conversion copies it.",
      input: {
        doctype: z.enum(["CRM Lead", "CRM Deal", "Contact", "CRM Organization"]),
        label: z.string(),
        fieldname: z.string().regex(/^[a-z][a-z0-9_]*$/).optional().describe("Default: label in snake_case"),
        fieldtype: z.enum(["Data", "Int", "Select", "Date", "Datetime", "Check", "Link"]),
        options: z.string().optional(),
        insert_after: z.string().optional(),
        show_in_layout: z.boolean().default(true),
        section_label: z.string().default("Calling").describe("Side panel section to add it to (created if missing)"),
      },
      kind: "write",
    },
    async (a, token) => {
      const fieldname = a.fieldname ?? a.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const options = a.fieldtype === "Select" && a.options && !a.options.startsWith("\n") ? `\n${a.options}` : a.options;
      const cf = await frappeRequest<{ data: any }>(token, "POST", resourcePath("Custom Field"), {
        body: { dt: a.doctype, label: a.label, fieldname, fieldtype: a.fieldtype, options, insert_after: a.insert_after },
      });
      let layout = "not added";
      if (a.show_in_layout) {
        const layoutName = `${a.doctype}-Side Panel`;
        const lay = (await frappeRequest<{ data: any }>(token, "GET", resourcePath("CRM Fields Layout", layoutName))).data;
        const sections: any[] = JSON.parse(lay.layout || "[]");
        let section = sections.find((s) => s.label === a.section_label);
        if (!section) {
          section = {
            name: `${a.section_label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_section`,
            label: a.section_label,
            opened: true,
            columns: [{ name: `${fieldname}_column`, fields: [] }],
          };
          sections.unshift(section);
        }
        const fields: string[] = section.columns[0].fields;
        if (!fields.includes(fieldname)) fields.push(fieldname);
        await frappeRequest(token, "PUT", resourcePath("CRM Fields Layout", layoutName), {
          body: { layout: JSON.stringify(sections) },
        });
        layout = `added to side panel section "${a.section_label}"`;
      }
      return { field: cf.data.fieldname, doctype: a.doctype, layout };
    },
  );

  defineTool(
    server,
    "invite_user",
    {
      title: "Invite a user to the CRM",
      description:
        "Sends CRM invitations by email. Sales User sees only leads/deals they own or are assigned; Sales Manager sees all. Inviting Sales Managers needs a System Manager.",
      input: {
        emails: z.array(z.string().email()).min(1),
        role: z.enum(["Sales User", "Sales Manager"]),
      },
      kind: "send",
    },
    async ({ emails, role }, token) => {
      await callMethod(token, "crm.api.invite_by_email", { emails: emails.join(","), role });
      return { invited: emails, role };
    },
  );
}
