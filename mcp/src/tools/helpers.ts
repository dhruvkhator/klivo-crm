import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { frappeRequest } from "../frappe.js";

/** Doctypes Claude may read. Frappe still applies the signed-in user's own permissions on top. */
export const READ_DOCTYPES = [
  "CRM Lead",
  "CRM Deal",
  "Contact",
  "CRM Organization",
  "FCRM Note",
  "CRM Task",
  "CRM Call Log",
  "Communication",
  "Comment",
  "File",
  "Email Template",
  "CRM Lead Status",
  "CRM Deal Status",
  "CRM Lead Source",
  "CRM Industry",
  "CRM Territory",
  "CRM Lost Reason",
  "CRM Product",
  "CRM Notification",
] as const;

/** Doctypes Claude may create/update (settings lists included, so statuses etc. can be managed from chat). */
export const WRITE_DOCTYPES = [
  "CRM Lead",
  "CRM Deal",
  "Contact",
  "CRM Organization",
  "FCRM Note",
  "CRM Task",
  "CRM Product",
  "CRM Lead Status",
  "CRM Deal Status",
  "CRM Lead Source",
  "CRM Industry",
  "CRM Territory",
  "CRM Lost Reason",
  "Email Template",
] as const;

/** Doctypes the two-step delete may remove. */
export const DELETE_DOCTYPES = [
  "CRM Lead",
  "CRM Deal",
  "Contact",
  "CRM Organization",
  "FCRM Note",
  "CRM Task",
  "Comment",
  "CRM Call Log",
  "CRM Product",
  "Email Template",
  "File",
  "CRM Lead Status",
  "CRM Deal Status",
  "CRM Lead Source",
  "CRM Industry",
  "CRM Territory",
  "CRM Lost Reason",
  "WhatsApp Templates",
] as const;

export const LEAD_OR_DEAL = z.enum(["CRM Lead", "CRM Deal"]);

export const filtersSchema = z
  .array(z.tuple([z.string(), z.string(), z.any()]))
  .optional()
  .describe(
    'Frappe filters as [field, operator, value] triples, e.g. [["status","=","New"],["lead_name","like","%acme%"],["modified",">","2026-01-01"]]. Operators: = != > < >= <= like "not like" in "not in" between "is" (value "set"/"not set").',
  );

const MAX_OUTPUT_CHARS = 60_000;

type Extra = { authInfo?: { token: string; extra?: Record<string, unknown> } };

export interface ToolDef<S extends ZodRawShape> {
  title: string;
  description: string;
  input?: S;
  /** read = no side effects; write = creates/changes data; send = reaches people outside the CRM; delete = removes data */
  kind: "read" | "write" | "send" | "delete";
}

/**
 * Registers a tool: injects the signed-in user's token, logs the call,
 * and turns any thrown error into a readable tool error for Claude.
 */
export function defineTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, token: string, user: string) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input ?? ({} as S),
      annotations: {
        readOnlyHint: def.kind === "read",
        destructiveHint: def.kind === "delete",
        openWorldHint: def.kind === "send",
      },
    },
    (async (args: any, extra: Extra): Promise<CallToolResult> => {
      console.log(`[tool] ${name} by ${extra.authInfo?.extra?.user ?? "?"}`);
      try {
        const token = extra.authInfo?.token;
        if (!token) throw new Error("Not authenticated");
        return ok(await handler(args ?? {}, token, String(extra.authInfo?.extra?.user ?? "")));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }) as any,
  );
}

function ok(data: unknown): CallToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated; narrow the query with filters/fields/limit)`;
  }
  return { content: [{ type: "text", text }] };
}

export const resourcePath = (doctype: string, name?: string) =>
  `/api/resource/${encodeURIComponent(doctype)}${name !== undefined ? `/${encodeURIComponent(name)}` : ""}`;

/** Calls a whitelisted Frappe/CRM Python method and returns its `message`. */
export async function callMethod<T = unknown>(
  token: string,
  method: string,
  args: Record<string, unknown> = {},
  httpMethod: "GET" | "POST" = "POST",
): Promise<T> {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const res =
    httpMethod === "GET"
      ? await frappeRequest<{ message: T }>(token, "GET", `/api/method/${method}`, {
          query: Object.fromEntries(
            Object.entries(clean).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
          ),
        })
      : await frappeRequest<{ message: T }>(token, "POST", `/api/method/${method}`, { body: clean });
  return res.message;
}

/** Fetches every matching row (paged), for duplicate checks and exports. */
export async function fetchAll<T = any>(
  token: string,
  doctype: string,
  fields: string[],
  filters: unknown[] = [],
  max = 200_000,
): Promise<T[]> {
  const out: T[] = [];
  const page = 5000;
  for (let start = 0; start < max; start += page) {
    const res = await frappeRequest<{ data: T[] }>(token, "GET", resourcePath(doctype), {
      query: {
        fields: JSON.stringify(fields),
        filters: filters.length ? JSON.stringify(filters) : undefined,
        order_by: "creation asc",
        limit_page_length: page,
        limit_start: start,
      },
      timeoutMs: 60_000,
    });
    out.push(...res.data);
    if (res.data.length < page) break;
  }
  return out;
}

/**
 * Platform bug B1: the CRM only computes product line amounts and totals in the browser.
 * Compute them here before any API write so values and the deal value are right.
 */
export function withProductTotals(data: Record<string, any>): Record<string, any> {
  if (!Array.isArray(data.products) || !data.products.length) return data;
  let total = 0;
  let netTotal = 0;
  const products = data.products.map((p: any) => {
    const qty = Number(p.qty ?? 1) || 0;
    const rate = Number(p.rate ?? 0) || 0;
    const amount = qty * rate;
    const pct = Number(p.discount_percentage ?? 0) || 0;
    const discount = pct ? (amount * pct) / 100 : Number(p.discount_amount ?? 0) || 0;
    const net = amount - discount;
    total += amount;
    netTotal += net;
    return { ...p, qty, rate, amount, discount_percentage: pct, discount_amount: discount, net_amount: net };
  });
  return { ...data, products, total, net_total: netTotal };
}

/** Uploads a file to the CRM (Frappe upload_file), optionally attached to a record. */
export async function uploadFile(
  token: string,
  file: { name: string; content: Buffer; isPrivate: boolean; doctype?: string; docname?: string },
): Promise<{ name: string; file_url: string; file_name: string; file_size?: number }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.content)]), file.name);
  form.append("file_name", file.name);
  form.append("is_private", file.isPrivate ? "1" : "0");
  if (file.doctype && file.docname) {
    form.append("doctype", file.doctype);
    form.append("docname", file.docname);
  }
  const res = await frappeRequest<{ message: any }>(token, "POST", "/api/method/upload_file", { form, timeoutMs: 120_000 });
  return res.message;
}
