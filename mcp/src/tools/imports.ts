import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { frappeDownload, frappeRequest } from "../frappe.js";
import { consumeApproval, issueApproval } from "../lib/approvals.js";
import { EMAIL_RE, emailKey, parseCsv, phoneKey, toCsv, toE164 } from "../lib/normalize.js";
import { callMethod, defineTool, fetchAll, resourcePath, uploadFile } from "./helpers.js";

const IMPORT_DOCTYPES = z.enum(["CRM Lead", "Contact", "CRM Organization"]);
type ImportDoctype = z.infer<typeof IMPORT_DOCTYPES>;
const PREVIEW_TTL = 24 * 60 * 60;
const MAX_ROWS = 60_000;

const REQUIRED: Record<ImportDoctype, string[]> = {
  "CRM Lead": ["first_name"],
  Contact: ["first_name"],
  "CRM Organization": ["organization_name"],
};
const EMAIL_FIELDS = ["email", "email_id"];
const PHONE_FIELDS = ["mobile_no", "phone"];
/** Link fields whose allowed values are worth listing/validating (small master lists). */
const SMALL_LINKS = new Set([
  "CRM Lead Status",
  "CRM Lead Source",
  "CRM Industry",
  "CRM Territory",
  "Salutation",
  "Gender",
  "Currency",
  "Country",
  "User",
  "CRM Organization",
]);

type Row = Record<string, any>;
type Verdict =
  | { row: number; verdict: "new" }
  | { row: number; verdict: "duplicate_in_file"; of_row: number; matched_on: string }
  | { row: number; verdict: "exists_in_crm"; record_type: string; record_id: string; matched_on: string }
  | { row: number; verdict: "invalid"; reasons: string[] };

interface Preview {
  doctype: ImportDoctype;
  import_batch?: string;
  rows: Row[];
  verdicts: Verdict[];
}

interface Job {
  id: string;
  user: string;
  doctype: string;
  state: "running" | "done" | "failed";
  total: number;
  processed: number;
  created: string[];
  updated: string[];
  skipped: number;
  failed: { row: number; error: string }[];
  warnings: string[];
  error_report_url?: string;
  started_at: string;
  finished_at?: string;
}

const staging = new Map<string, { user: string; rows: Row[]; expires: number }>();
const jobs = new Map<string, Job>();

async function getMeta(token: string, doctype: string) {
  const res = await frappeRequest<{ docs: any[] }>(token, "GET", "/api/method/frappe.desk.form.load.getdoctype", { query: { doctype } });
  return res.docs.find((d) => d.name === doctype) ?? res.docs[0];
}

/** System/workflow fields that should never come from a sheet. */
const SYSTEM_FIELDS = new Set([
  "naming_series", "converted", "sla", "sla_creation", "sla_status", "response_by", "first_response_time",
  "first_responded_on", "communication_status", "status_change_log", "lead_score", "image", "lost_reason", "lost_notes",
]);
const SKIP_TYPES = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Fold", "Table", "Table MultiSelect", "Attach Image"]);

async function importableFields(token: string, doctype: ImportDoctype) {
  const meta = await getMeta(token, doctype);
  const fields = (meta.fields as any[]).filter(
    (f) =>
      !SKIP_TYPES.has(f.fieldtype) &&
      !SYSTEM_FIELDS.has(f.fieldname) &&
      !f.hidden &&
      !(f.read_only && !["email_id", "mobile_no", "phone"].includes(f.fieldname)),
  );
  return fields;
}

async function allowedValues(token: string, fields: any[]) {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    if (f.fieldtype === "Select" && f.options) out[f.fieldname] = String(f.options).split("\n").filter(Boolean);
    else if (f.fieldtype === "Link" && SMALL_LINKS.has(f.options)) {
      const filters = f.options === "User" ? [["enabled", "=", 1], ["user_type", "=", "System User"]] : [];
      const rows = await fetchAll<{ name: string }>(token, f.options, ["name"], filters, 2000).catch(() => []);
      out[f.fieldname] = rows.map((r) => r.name);
    }
  }
  return out;
}

async function loadRows(token: string, user: string, src: { file_id?: string; rows?: Row[]; staging_id?: string }): Promise<Row[]> {
  if (src.rows?.length) return src.rows;
  if (src.staging_id) {
    const s = staging.get(src.staging_id);
    if (!s || s.user !== user || s.expires < Date.now()) throw new Error("Unknown or expired staging_id");
    return s.rows;
  }
  if (src.file_id) {
    const file = (await frappeRequest<{ data: any }>(token, "GET", resourcePath("File", src.file_id))).data;
    if (!/\.csv$/i.test(file.file_name ?? file.file_url)) throw new Error("Only CSV files are supported. Save the sheet as CSV first.");
    return parseCsv((await frappeDownload(token, file.file_url)).toString("utf8"));
  }
  throw new Error("Give rows, staging_id or file_id");
}

/** Indexes existing CRM emails/phones (and org names) for duplicate matching. */
async function buildIndex(token: string, withOrgs: boolean) {
  const byKey = new Map<string, { type: string; id: string; on: string }>();
  const add = (key: string | undefined, type: string, id: string, on: string) => {
    if (key && !byKey.has(key)) byKey.set(key, { type, id, on });
  };
  const [leads, deals] = await Promise.all([
    fetchAll<any>(token, "CRM Lead", ["name", "email", "mobile_no", "phone"]),
    fetchAll<any>(token, "CRM Deal", ["name", "email", "mobile_no"]).catch(() => []),
  ]);
  for (const l of leads) {
    add(`e:${emailKey(l.email)}`, "CRM Lead", l.name, "email");
    add(`p:${phoneKey(l.mobile_no)}`, "CRM Lead", l.name, "mobile_no");
    add(`p:${phoneKey(l.phone)}`, "CRM Lead", l.name, "phone");
  }
  for (const d of deals) {
    add(`e:${emailKey(d.email)}`, "CRM Deal", d.name, "email");
    add(`p:${phoneKey(d.mobile_no)}`, "CRM Deal", d.name, "mobile_no");
  }
  const childList = (doctype: string, fields: string[]) =>
    callMethod<any[]>(token, "frappe.client.get_list", { doctype, parent: "Contact", fields, limit_page_length: 0 }, "GET").catch(() => []);
  const [cEmails, cPhones] = await Promise.all([childList("Contact Email", ["email_id", "parent"]), childList("Contact Phone", ["phone", "parent"])]);
  for (const e of cEmails) add(`e:${emailKey(e.email_id)}`, "Contact", e.parent, "email");
  for (const p of cPhones) add(`p:${phoneKey(p.phone)}`, "Contact", p.parent, "phone");
  if (withOrgs) {
    const orgs = await fetchAll<any>(token, "CRM Organization", ["name", "organization_name"]);
    for (const o of orgs) add(`o:${String(o.organization_name ?? o.name).trim().toLowerCase()}`, "CRM Organization", o.name, "organization name");
  }
  for (const k of [...byKey.keys()]) if (k.endsWith(":undefined")) byKey.delete(k);
  return byKey;
}

function rowKeys(doctype: ImportDoctype, row: Row, dedupe: string[], matchOrg: boolean): { key: string; on: string }[] {
  const keys: { key: string; on: string }[] = [];
  for (const f of dedupe) {
    const v = row[f];
    if (!v) continue;
    if (EMAIL_FIELDS.includes(f)) keys.push({ key: `e:${emailKey(v)}`, on: f });
    else if (PHONE_FIELDS.includes(f)) keys.push({ key: `p:${phoneKey(v)}`, on: f });
  }
  const org = doctype === "CRM Organization" ? row.organization_name : matchOrg ? row.organization : undefined;
  if (org) keys.push({ key: `o:${String(org).trim().toLowerCase()}`, on: "organization name" });
  return keys.filter((k) => !k.key.endsWith(":undefined"));
}

function toContactDoc(row: Row) {
  const { email_id, mobile_no, phone, ...rest } = row;
  return {
    ...rest,
    email_ids: email_id ? [{ email_id, is_primary: 1 }] : [],
    phone_nos: [
      ...(mobile_no ? [{ phone: mobile_no, is_primary_mobile_no: 1 }] : []),
      ...(phone ? [{ phone, is_primary_phone: 1 }] : []),
    ],
  };
}

async function setAutomationsDisabled(token: string, disabled: boolean): Promise<boolean | undefined> {
  const path = resourcePath("Automation Settings", "Automation Settings");
  const cur = (await frappeRequest<{ data: any }>(token, "GET", path)).data;
  const was = !!cur.disable_automations;
  if (was !== disabled) await frappeRequest(token, "PUT", path, { body: { disable_automations: disabled ? 1 : 0 } });
  return was;
}

async function runImport(job: Job, token: string, p: Preview, onDuplicate: string, batchSize: number, mute: boolean) {
  let restoreAutomations: boolean | undefined;
  try {
    if (mute) {
      restoreAutomations = await setAutomationsDisabled(token, true).catch((e) => {
        job.warnings.push(`Could not pause automations (needs System Manager): ${e.message}`);
        return undefined;
      });
    }
    const toDoc = (r: Row) => ({
      ...(p.doctype === "Contact" ? toContactDoc(r) : r),
      ...(p.import_batch && p.doctype === "CRM Lead" ? { import_batch: p.import_batch } : {}),
      doctype: p.doctype,
    });
    const newRows = p.verdicts.filter((v) => v.verdict === "new").map((v) => v.row);
    const existing = p.verdicts.filter((v): v is Extract<Verdict, { verdict: "exists_in_crm" }> => v.verdict === "exists_in_crm");
    job.skipped = p.verdicts.length - newRows.length - (onDuplicate === "skip" ? 0 : existing.filter((e) => e.record_type === p.doctype).length);

    for (let i = 0; i < newRows.length; i += batchSize) {
      const chunk = newRows.slice(i, i + batchSize);
      try {
        const names = await callMethod<string[]>(token, "frappe.client.insert_many", { docs: chunk.map((n) => toDoc(p.rows[n - 1])) });
        job.created.push(...names);
      } catch {
        // One bad row fails the whole request: retry row by row to keep the good ones.
        for (const n of chunk) {
          try {
            const r = await frappeRequest<{ data: any }>(token, "POST", resourcePath(p.doctype), { body: toDoc(p.rows[n - 1]) });
            job.created.push(r.data.name);
          } catch (err) {
            job.failed.push({ row: n, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      job.processed += chunk.length;
    }

    if (onDuplicate !== "skip") {
      for (const e of existing) {
        if (e.record_type !== p.doctype || p.doctype === "Contact") {
          job.processed++;
          continue;
        }
        try {
          const cur = (await frappeRequest<{ data: any }>(token, "GET", resourcePath(p.doctype, e.record_id))).data;
          const patch: Row = {};
          for (const [k, v] of Object.entries(p.rows[e.row - 1])) {
            if (v === "" || v === undefined || v === null) continue;
            if (onDuplicate === "overwrite" || cur[k] === null || cur[k] === undefined || cur[k] === "" || cur[k] === 0) patch[k] = v;
          }
          if (Object.keys(patch).length) {
            await frappeRequest(token, "PUT", resourcePath(p.doctype, e.record_id), { body: patch });
            job.updated.push(e.record_id);
          }
        } catch (err) {
          job.failed.push({ row: e.row, error: err instanceof Error ? err.message : String(err) });
        }
        job.processed++;
      }
    }
    if (job.failed.length) {
      const f = await uploadFile(token, {
        name: `import-errors-${job.id}.csv`,
        content: Buffer.from(toCsv(job.failed.map((x) => ({ ...p.rows[x.row - 1], row: x.row, error: x.error })))),
        isPrivate: true,
      }).catch(() => undefined);
      if (f) job.error_report_url = `${config.frappeUrl}${f.file_url}`;
    }
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.warnings.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (mute && restoreAutomations === false) {
      await setAutomationsDisabled(token, false).catch((e) => job.warnings.push(`Re-enable automations manually! ${e.message}`));
    }
    job.finished_at = new Date().toISOString();
    console.log(`[import] ${job.id} ${job.state}: created ${job.created.length}, updated ${job.updated.length}, failed ${job.failed.length}`);
  }
}

/** M1: bulk import with duplicate checking. */
export function registerImportTools(server: McpServer) {
  defineTool(
    server,
    "get_import_template",
    {
      title: "Import template",
      description:
        "Columns you can import for leads, contacts or organizations: field names, types, required fields, and allowed values for status, source, industry, territory, owner, employee bands etc. Use it to map the user's sheet before import_preview.",
      input: { doctype: IMPORT_DOCTYPES.default("CRM Lead") },
      kind: "read",
    },
    async ({ doctype }, token) => {
      const fields = await importableFields(token, doctype);
      const allowed = await allowedValues(token, fields);
      return {
        doctype,
        required: REQUIRED[doctype],
        columns: fields.map((f) => ({
          field: f.fieldname,
          label: f.label,
          type: f.fieldtype,
          ...(f.fieldtype === "Link" ? { link_to: f.options } : {}),
          ...(allowed[f.fieldname] ? { allowed_values: allowed[f.fieldname] } : {}),
        })),
        phone_format: "Any format; stored as E.164 (+919820012345). 10-digit numbers get +91.",
        duplicate_check:
          "Emails (case/space-insensitive) and phones (last 10 digits) are matched against leads, contacts (all their emails/phones) and deals; optionally organization names.",
        note:
          doctype === "CRM Lead"
            ? "Each imported lead is tagged with import_batch so the batch can be found or deleted later."
            : undefined,
      };
    },
  );

  defineTool(
    server,
    "import_stage_rows",
    {
      title: "Stage rows for an import",
      description:
        "For big sheets sent through chat: add up to 1000 rows per call (keys = CRM field names or the sheet's columns). Omit staging_id on the first call; pass the returned staging_id on the next calls, then call import_preview with it. Staged rows live 24 hours.",
      input: { staging_id: z.string().optional(), rows: z.array(z.record(z.string(), z.any())).min(1).max(1000) },
      kind: "read",
    },
    async ({ staging_id, rows }, _token, user) => {
      let id = staging_id;
      if (!id) {
        id = `stg_${randomBytes(8).toString("hex")}`;
        staging.set(id, { user, rows: [], expires: Date.now() + PREVIEW_TTL * 1000 });
      }
      const s = staging.get(id);
      if (!s || s.user !== user) throw new Error("Unknown staging_id");
      if (s.rows.length + rows.length > MAX_ROWS) throw new Error(`Max ${MAX_ROWS} rows per import`);
      s.rows.push(...rows);
      return { staging_id: id, total_rows: s.rows.length };
    },
  );

  defineTool(
    server,
    "import_preview",
    {
      title: "Preview an import (writes nothing)",
      description:
        "Validates every row and checks duplicates within the file and against the CRM, without writing anything. Source: rows (small lists), staging_id (import_stage_rows) or file_id (a CSV uploaded with upload_file). column_map renames sheet columns to CRM fields ({\"Phone Number\":\"mobile_no\"}); unmapped columns that aren't CRM fields are ignored. Returns counts, problem rows, a downloadable report and a preview_token for import_commit (valid 24h). Note: duplicate checks only see records the signed-in user can see, so run imports as a Sales Manager or admin.",
      input: {
        doctype: IMPORT_DOCTYPES.default("CRM Lead"),
        file_id: z.string().optional(),
        rows: z.array(z.record(z.string(), z.any())).max(1000).optional(),
        staging_id: z.string().optional(),
        column_map: z.record(z.string(), z.string()).optional(),
        dedupe_keys: z.array(z.string()).default(["email", "email_id", "mobile_no", "phone"]),
        match_organization_name: z.boolean().default(false).describe("Also treat a lead whose organization already exists as a duplicate"),
        default_values: z.record(z.string(), z.any()).optional().describe('Applied where a row is empty, e.g. {"source":"Cold Calling","status":"New"}'),
        import_batch: z.string().optional().describe("Tag for this batch, e.g. IMP-2026-12-01-A (default generated)"),
      },
      kind: "read",
    },
    async (a, token, user) => {
      const raw = await loadRows(token, user, a);
      if (!raw.length) throw new Error("No rows found");
      if (raw.length > MAX_ROWS) throw new Error(`Max ${MAX_ROWS} rows per import; split the file`);
      const fields = await importableFields(token, a.doctype);
      const fieldNames = new Set(fields.map((f) => f.fieldname));
      const allowed = await allowedValues(token, fields);
      const typeOf = Object.fromEntries(fields.map((f) => [f.fieldname, f.fieldtype]));
      const batch = a.doctype === "CRM Lead" ? (a.import_batch ?? `IMP-${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString("hex").toUpperCase()}`) : undefined;
      const ignored = new Set<string>();

      const rows: Row[] = raw.map((r) => {
        const out: Row = {};
        for (const [col, val] of Object.entries(r)) {
          const field = a.column_map?.[col] ?? col;
          if (!fieldNames.has(field)) {
            ignored.add(col);
            continue;
          }
          const v = typeof val === "string" ? val.trim() : val;
          if (v !== "" && v !== null && v !== undefined) out[field] = v;
        }
        for (const [k, v] of Object.entries(a.default_values ?? {})) {
          if (fieldNames.has(k) && out[k] === undefined) out[k] = v;
        }
        return out;
      });

      const index = await buildIndex(token, a.match_organization_name || a.doctype === "CRM Organization");
      const seen = new Map<string, number>();
      const verdicts: Verdict[] = rows.map((row, i) => {
        const n = i + 1;
        const reasons: string[] = [];
        for (const req of REQUIRED[a.doctype]) if (!row[req]) reasons.push(`missing ${req}`);
        for (const f of EMAIL_FIELDS) {
          if (row[f] === undefined) continue;
          const e = String(row[f]).replace(/\s+/g, "").toLowerCase();
          if (!EMAIL_RE.test(e)) reasons.push(`bad email "${row[f]}"`);
          else row[f] = e;
        }
        for (const f of PHONE_FIELDS) {
          if (row[f] === undefined) continue;
          const p = toE164(row[f]);
          if (!p) reasons.push(`bad ${f} "${row[f]}"`);
          else row[f] = p;
        }
        for (const [f, values] of Object.entries(allowed)) {
          if (row[f] === undefined) continue;
          const hit = values.find((v) => v.toLowerCase() === String(row[f]).toLowerCase());
          if (!hit) reasons.push(`${f} "${row[f]}" is not an allowed value`);
          else row[f] = hit;
        }
        for (const [f, t] of Object.entries(typeOf)) {
          if (row[f] === undefined) continue;
          if ((t === "Int" || t === "Currency" || t === "Float" || t === "Percent") && Number.isNaN(Number(row[f]))) reasons.push(`${f} must be a number`);
        }
        if (reasons.length) return { row: n, verdict: "invalid", reasons };
        const keys = rowKeys(a.doctype, row, a.dedupe_keys, a.match_organization_name);
        for (const k of keys) {
          const prev = seen.get(k.key);
          if (prev) return { row: n, verdict: "duplicate_in_file", of_row: prev, matched_on: k.on };
        }
        for (const k of keys) seen.set(k.key, n);
        for (const k of keys) {
          const hit = index.get(k.key);
          if (hit) return { row: n, verdict: "exists_in_crm", record_type: hit.type, record_id: hit.id, matched_on: hit.on };
        }
        return { row: n, verdict: "new" };
      });

      const counts = verdicts.reduce<Record<string, number>>((acc, v) => ((acc[v.verdict] = (acc[v.verdict] ?? 0) + 1), acc), {});
      const report = await uploadFile(token, {
        name: `import-preview-${batch ?? a.doctype.replace(/\s+/g, "-")}.csv`,
        content: Buffer.from(
          toCsv(
            verdicts.map((v) => ({
              row: v.row,
              verdict: v.verdict,
              detail:
                v.verdict === "invalid"
                  ? v.reasons.join("; ")
                  : v.verdict === "duplicate_in_file"
                    ? `same ${v.matched_on} as row ${v.of_row}`
                    : v.verdict === "exists_in_crm"
                      ? `${v.record_type} ${v.record_id} (${v.matched_on})`
                      : "",
              ...rows[v.row - 1],
            })),
          ),
        ),
        isPrivate: true,
      }).catch(() => undefined);

      const preview: Preview = { doctype: a.doctype, import_batch: batch, rows, verdicts };
      const t = issueApproval("import", user, preview, PREVIEW_TTL);
      return {
        preview_token: t.token,
        expires_at: t.expires_at,
        doctype: a.doctype,
        total_rows: rows.length,
        counts,
        import_batch: batch,
        ignored_columns: [...ignored],
        problems: verdicts.filter((v) => v.verdict !== "new").slice(0, 100),
        sample_new_rows: verdicts.filter((v) => v.verdict === "new").slice(0, 3).map((v) => rows[v.row - 1]),
        report_url: report ? `${config.frappeUrl}${report.file_url}` : undefined,
        next: "Show the counts and problems to the user. After their OK call import_commit with preview_token.",
      };
    },
  );

  defineTool(
    server,
    "import_commit",
    {
      title: "Run an import",
      description:
        "Imports the rows from an approved import_preview in the background and returns a job_id (check import_status). on_duplicate: skip (default), fill_empty (fill only empty fields of the existing lead), overwrite. mute_notifications pauses automation flows during the import so thousands of rows don't start sequences (needs admin). Only after the user approved the preview.",
      input: {
        preview_token: z.string(),
        on_duplicate: z.enum(["skip", "fill_empty", "overwrite"]).default("skip"),
        batch_size: z.number().int().min(10).max(200).default(100),
        mute_notifications: z.boolean().default(true),
      },
      kind: "write",
    },
    async ({ preview_token, on_duplicate, batch_size, mute_notifications }, token, user) => {
      const p = consumeApproval<Preview>(preview_token, "import", user);
      const toWrite = p.verdicts.filter((v) => v.verdict === "new" || (on_duplicate !== "skip" && v.verdict === "exists_in_crm")).length;
      const job: Job = {
        id: `job_${randomBytes(6).toString("hex")}`,
        user,
        doctype: p.doctype,
        state: "running",
        total: toWrite,
        processed: 0,
        created: [],
        updated: [],
        skipped: 0,
        failed: [],
        warnings: [],
        started_at: new Date().toISOString(),
      };
      jobs.set(job.id, job);
      console.log(`[import] ${job.id} by ${user}: ${toWrite} rows into ${p.doctype}`);
      void runImport(job, token, p, on_duplicate, batch_size, mute_notifications);
      return { job_id: job.id, rows_to_write: toWrite, import_batch: p.import_batch };
    },
  );

  defineTool(
    server,
    "import_status",
    {
      title: "Import progress",
      description: "Progress and results of an import job: created, updated, skipped and failed counts, created IDs, and an error CSV link for failed rows.",
      input: { job_id: z.string() },
      kind: "read",
    },
    async ({ job_id }, _token, user) => {
      const j = jobs.get(job_id);
      if (!j || j.user !== user) throw new Error("Unknown job_id (jobs are kept until the connector restarts)");
      return {
        state: j.state,
        progress: `${j.processed}/${j.total}`,
        created: j.created.length,
        updated: j.updated.length,
        skipped: j.skipped,
        failed: j.failed.length,
        created_ids_sample: j.created.slice(0, 50),
        failed_sample: j.failed.slice(0, 20),
        error_report_url: j.error_report_url,
        warnings: j.warnings,
        started_at: j.started_at,
        finished_at: j.finished_at,
      };
    },
  );
}
