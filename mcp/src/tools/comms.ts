import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { frappeRequest } from "../frappe.js";
import { consumeApproval, issueApproval } from "../lib/approvals.js";
import { emailKey, toE164 } from "../lib/normalize.js";
import { callMethod, defineTool, LEAD_OR_DEAL, resourcePath, uploadFile } from "./helpers.js";

const emails = z.array(z.string().email());
const DNC_STATUS = "Do Not Contact";
const SEND_TTL = 60 * 60; // an approved draft stays valid for 1 hour
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function getDoc<T = any>(token: string, doctype: string, name: string): Promise<T> {
  return (await frappeRequest<{ data: T }>(token, "GET", resourcePath(doctype, name))).data;
}

/**
 * Guardrail: refuse to contact a lead/deal (or any recipient) marked "Do Not Contact".
 * For a deal, the status of the lead it came from counts.
 */
async function assertContactable(token: string, doctype: string, name: string, recipients: string[] = []) {
  const doc = await getDoc(token, doctype, name);
  let status = doctype === "CRM Lead" ? doc.status : undefined;
  if (doctype === "CRM Deal" && doc.lead) {
    status = await getDoc(token, "CRM Lead", doc.lead)
      .then((l) => l.status)
      .catch(() => undefined);
  }
  if (status === DNC_STATUS) throw new Error(`${name} is marked "${DNC_STATUS}". Not sending.`);
  const keys = recipients.map(emailKey).filter(Boolean) as string[];
  if (keys.length) {
    const blocked = await frappeRequest<{ data: { name: string; email: string }[] }>(token, "GET", resourcePath("CRM Lead"), {
      query: {
        fields: JSON.stringify(["name", "email"]),
        filters: JSON.stringify([
          ["status", "=", DNC_STATUS],
          ["email", "in", keys],
        ]),
        limit_page_length: 50,
      },
    });
    if (blocked.data.length) {
      throw new Error(
        `Recipient(s) marked "${DNC_STATUS}": ${blocked.data.map((b) => `${b.email} (${b.name})`).join(", ")}. Not sending.`,
      );
    }
  }
  return doc;
}

async function whatsappReady(token: string) {
  const installed = await callMethod<boolean>(token, "crm.api.whatsapp.is_whatsapp_installed", {}, "GET").catch(() => false);
  const enabled = installed
    ? await callMethod<boolean>(token, "crm.api.whatsapp.is_whatsapp_enabled", {}, "GET").catch(() => false)
    : false;
  return { installed: !!installed, enabled: !!enabled };
}

async function requireWhatsapp(token: string) {
  const s = await whatsappReady(token);
  if (!s.installed) throw new Error("WhatsApp is not installed on the CRM (the frappe_whatsapp app is missing).");
  if (!s.enabled) throw new Error("WhatsApp is installed but not enabled/configured in WhatsApp Settings.");
}

interface EmailDraft {
  doctype: string;
  name: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  content: string;
  sender: string;
  sender_full_name?: string;
  in_reply_to?: string;
  attachments?: string[];
}

interface WhatsappDraft {
  mode: "text" | "template";
  reference_doctype: string;
  reference_name: string;
  to: string;
  message?: string;
  template?: string;
  attach?: string;
  content_type?: string;
  reply_to?: string;
}

/** Email, templates, files, comments and WhatsApp. */
export function registerCommsTools(server: McpServer) {
  // ---------- Email: two-step send ----------
  defineTool(
    server,
    "prepare_email",
    {
      title: "Prepare an email (step 1 of 2)",
      description:
        "Builds the exact email to send from a lead or deal: either your own subject+content, or an Email Template rendered with the record's data. Returns the final recipients, subject, body and attachments plus an approval_id. Show all of it to the user, wait for their explicit OK, then call send_email with the approval_id. Refuses recipients marked Do Not Contact. Attachments are File IDs (upload_file / list_attachments).",
      input: {
        reference_doctype: LEAD_OR_DEAL,
        reference_name: z.string().describe("Lead or deal ID"),
        to: emails.min(1),
        cc: emails.optional(),
        bcc: emails.optional(),
        template: z.string().optional().describe("Email Template name; if given, subject/content come from it"),
        subject: z.string().optional(),
        content: z.string().optional().describe("Email body, HTML or plain text"),
        sender: z.string().email().optional().describe("From address; default is the signed-in user's"),
        in_reply_to: z.string().optional().describe("Communication ID being replied to"),
        attachments: z.array(z.string()).optional().describe("File IDs to attach"),
      },
      kind: "read",
    },
    async (a, token, user) => {
      const doc = await assertContactable(token, a.reference_doctype, a.reference_name, [...a.to, ...(a.cc ?? []), ...(a.bcc ?? [])]);
      let subject = a.subject;
      let content = a.content;
      if (a.template) {
        const r = await callMethod<{ subject: string; message: string }>(
          token,
          "frappe.email.doctype.email_template.email_template.get_email_template",
          { template_name: a.template, doc },
        );
        subject = a.subject ?? r.subject;
        content = r.message;
      }
      if (!subject || !content) throw new Error("Give a template, or both subject and content.");
      const me = await callMethod<string>(token, "frappe.auth.get_logged_user", {}, "GET");
      const fullName = await getDoc<{ full_name?: string }>(token, "User", me)
        .then((u) => u.full_name)
        .catch(() => undefined);
      const attachments = a.attachments?.length
        ? await Promise.all(
            a.attachments.map((id) =>
              getDoc(token, "File", id).then((f) => ({ id, file_name: f.file_name, file_size: f.file_size })),
            ),
          )
        : [];
      const draft: EmailDraft = {
        doctype: a.reference_doctype,
        name: a.reference_name,
        to: a.to,
        cc: a.cc,
        bcc: a.bcc,
        subject,
        content,
        sender: a.sender ?? me,
        sender_full_name: fullName,
        in_reply_to: a.in_reply_to,
        attachments: a.attachments,
      };
      const approval = issueApproval("email", user, draft, SEND_TTL);
      return {
        approval_id: approval.token,
        expires_at: approval.expires_at,
        from: draft.sender,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject,
        body: content,
        attachments,
        next: "Show this to the user. Only after they approve, call send_email with approval_id.",
      };
    },
  );

  defineTool(
    server,
    "send_email",
    {
      title: "Send a prepared email (step 2 of 2)",
      description:
        "Sends the email prepared by prepare_email, exactly as previewed, and logs it on the lead/deal timeline. Only call this after the user approved that preview. Needs an outgoing Email Account in the CRM (see list_email_accounts).",
      input: { approval_id: z.string() },
      kind: "send",
    },
    async ({ approval_id }, token, user) => {
      const d = consumeApproval<EmailDraft>(approval_id, "email", user);
      await assertContactable(token, d.doctype, d.name, [...d.to, ...(d.cc ?? []), ...(d.bcc ?? [])]);
      const result = await callMethod<{ name: string }>(token, "frappe.core.doctype.communication.email.make", {
        doctype: d.doctype,
        name: d.name,
        recipients: d.to.join(", "),
        cc: d.cc?.join(", "),
        bcc: d.bcc?.join(", "),
        subject: d.subject,
        content: d.content,
        sender: d.sender,
        sender_full_name: d.sender_full_name,
        in_reply_to: d.in_reply_to,
        attachments: d.attachments,
        send_email: 1,
      });
      return { sent: true, communication: result?.name ?? result };
    },
  );

  defineTool(
    server,
    "list_email_accounts",
    {
      title: "List email accounts",
      description:
        "Shows the CRM's email accounts: which can send (outgoing), which receive replies (incoming), and the default. If none can send, email sending will fail: tell the user up front.",
      kind: "read",
    },
    async (_a, token) => {
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("Email Account"), {
        query: {
          fields: JSON.stringify([
            "name",
            "email_id",
            "enable_outgoing",
            "default_outgoing",
            "enable_incoming",
            "default_incoming",
          ]),
          limit_page_length: 50,
        },
      });
      return res.data.length ? res.data : { accounts: [], note: "No email account is configured, so the CRM cannot send email yet." };
    },
  );

  defineTool(
    server,
    "list_emails",
    {
      title: "List emails of a lead or deal",
      description: "Lists emails sent/received on a lead or deal, newest first. Use get_record on Communication for a full body.",
      input: {
        reference_doctype: LEAD_OR_DEAL,
        reference_name: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
        include_body: z.boolean().default(false),
      },
      kind: "read",
    },
    async ({ reference_doctype, reference_name, limit, include_body }, token) => {
      const fields = [
        "name",
        "subject",
        "sender",
        "recipients",
        "cc",
        "sent_or_received",
        "communication_date",
        "read_by_recipient",
        "in_reply_to",
        ...(include_body ? ["content"] : []),
      ];
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("Communication"), {
        query: {
          fields: JSON.stringify(fields),
          filters: JSON.stringify([
            ["reference_doctype", "=", reference_doctype],
            ["reference_name", "=", reference_name],
            ["communication_medium", "=", "Email"],
          ]),
          order_by: "communication_date desc",
          limit_page_length: limit,
        },
      });
      return res.data;
    },
  );

  // ---------- Email templates ----------
  defineTool(
    server,
    "render_email_template",
    {
      title: "Render an email template",
      description:
        "Fills an Email Template with a lead's or deal's data and returns the subject and body, to review. To send it, use prepare_email with template.",
      input: { template: z.string().describe("Email Template name"), reference_doctype: LEAD_OR_DEAL, reference_name: z.string() },
      kind: "read",
    },
    async ({ template, reference_doctype, reference_name }, token) => {
      const doc = await getDoc(token, reference_doctype, reference_name);
      return callMethod(token, "frappe.email.doctype.email_template.email_template.get_email_template", {
        template_name: template,
        doc,
      });
    },
  );

  defineTool(
    server,
    "get_email_template",
    {
      title: "Get an email template",
      description: "Returns an Email Template with its raw Jinja subject and body. list_records on Email Template lists them all.",
      input: { name: z.string() },
      kind: "read",
    },
    async ({ name }, token) => {
      const t = await getDoc(token, "Email Template", name);
      return {
        name: t.name,
        subject: t.subject,
        body: t.use_html ? t.response_html : t.response,
        use_html: !!t.use_html,
        reference_doctype: t.reference_doctype,
        enabled: t.enabled,
      };
    },
  );

  const templateFields = {
    subject: z.string().describe("Jinja allowed, e.g. Quick question, {{ doc.first_name }}"),
    body_html: z.string().describe("HTML body with Jinja variables like {{ doc.first_name }}, {{ doc.organization }}"),
    reference_doctype: LEAD_OR_DEAL.describe("Which record type the template is written for"),
    enabled: z.boolean().default(true),
    sample_record: z.string().optional().describe("Lead/deal ID to test-render against; default: the latest record of that type"),
  };

  /**
   * Renders a saved template against a real record with the CRM's own renderer.
   * Throws if a variable is broken, so callers can roll the save back.
   */
  async function testRender(token: string, template: string, refType: string, sample?: string) {
    let name = sample;
    if (!name) {
      const latest = await frappeRequest<{ data: { name: string }[] }>(token, "GET", resourcePath(refType), {
        query: { fields: JSON.stringify(["name"]), order_by: "modified desc", limit_page_length: 1 },
      });
      name = latest.data[0]?.name;
    }
    // With no record yet, render against an empty one: syntax errors still surface.
    const doc = name ? await getDoc(token, refType, name) : { doctype: refType };
    try {
      const r = await callMethod<{ subject: string; message: string }>(
        token,
        "frappe.email.doctype.email_template.email_template.get_email_template",
        { template_name: template, doc },
      );
      return { sample_record: name ?? "(none yet, rendered with empty values)", subject: r.subject, body: r.message };
    } catch (err) {
      throw new Error(`Template does not render${name ? ` against ${name}` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  defineTool(
    server,
    "create_email_template",
    {
      title: "Create an email template",
      description:
        "Saves a new Email Template for leads or deals. Before saving it is test-rendered against a real record; it is rejected if a variable is broken. Returns the rendered sample.",
      input: { name: z.string().describe("Template name, e.g. 'Intro - Website Chatbot'"), ...templateFields },
      kind: "write",
    },
    async (a, token) => {
      const saved = await frappeRequest<{ data: any }>(token, "POST", resourcePath("Email Template"), {
        body: {
          name: a.name,
          subject: a.subject,
          use_html: 1,
          response_html: a.body_html,
          reference_doctype: a.reference_doctype,
          enabled: a.enabled ? 1 : 0,
        },
      });
      try {
        return { saved: saved.data.name, sample: await testRender(token, saved.data.name, a.reference_doctype, a.sample_record) };
      } catch (err) {
        await frappeRequest(token, "DELETE", resourcePath("Email Template", saved.data.name)).catch(() => undefined);
        throw err;
      }
    },
  );

  defineTool(
    server,
    "update_email_template",
    {
      title: "Update an email template",
      description: "Changes an Email Template's subject, body, enabled flag or record type. Re-tested before saving.",
      input: {
        name: z.string(),
        subject: z.string().optional(),
        body_html: z.string().optional(),
        reference_doctype: LEAD_OR_DEAL.optional(),
        enabled: z.boolean().optional(),
        sample_record: z.string().optional(),
      },
      kind: "write",
    },
    async (a, token) => {
      const cur = await getDoc(token, "Email Template", a.name);
      const subject = a.subject ?? cur.subject;
      const body = a.body_html ?? (cur.use_html ? cur.response_html : cur.response);
      const refType = a.reference_doctype ?? cur.reference_doctype ?? "CRM Lead";
      const patch: Record<string, unknown> = { subject, reference_doctype: refType };
      if (a.body_html !== undefined) Object.assign(patch, { use_html: 1, response_html: body });
      if (a.enabled !== undefined) patch.enabled = a.enabled ? 1 : 0;
      await frappeRequest(token, "PUT", resourcePath("Email Template", a.name), { body: patch });
      try {
        return { updated: a.name, sample: await testRender(token, a.name, refType, a.sample_record) };
      } catch (err) {
        // Put the previous version back.
        const { subject: s0, use_html, response, response_html, reference_doctype, enabled } = cur;
        await frappeRequest(token, "PUT", resourcePath("Email Template", a.name), {
          body: { subject: s0, use_html, response, response_html, reference_doctype, enabled },
        }).catch(() => undefined);
        throw err;
      }
    },
  );

  // ---------- Files ----------
  defineTool(
    server,
    "upload_file",
    {
      title: "Upload a file",
      description:
        "Saves a file in the CRM (deck, proposal, one-pager, or a CSV for import_preview) from base64 content, optionally attached to a lead or deal. Private by default. Returns the File ID (use it for email attachments or import_preview) and its URL. Max 25 MB.",
      input: {
        file_name: z.string().describe("e.g. Klivo-Intro.pdf"),
        content_base64: z.string().min(1),
        attach_to_doctype: z.enum(["CRM Lead", "CRM Deal", "Contact", "CRM Organization"]).optional(),
        attach_to_name: z.string().optional(),
        is_private: z.boolean().default(true),
      },
      kind: "write",
    },
    async (a, token) => {
      // Size check on the base64 text first, so an oversized upload is never decoded.
      if (a.content_base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) throw new Error("File is larger than 25 MB");
      const content = Buffer.from(a.content_base64, "base64");
      if (!content.length) throw new Error("File is empty");
      if (content.length > MAX_UPLOAD_BYTES) throw new Error("File is larger than 25 MB");
      const f = await uploadFile(token, {
        name: a.file_name,
        content,
        isPrivate: a.is_private,
        doctype: a.attach_to_doctype,
        docname: a.attach_to_name,
      });
      return { file_id: f.name, file_url: f.file_url, file_name: f.file_name, size: content.length };
    },
  );

  defineTool(
    server,
    "list_attachments",
    {
      title: "List attachments of a record",
      description: "Lists files attached to a lead, deal, contact or organization (File IDs usable as email attachments).",
      input: { doctype: z.enum(["CRM Lead", "CRM Deal", "Contact", "CRM Organization"]), name: z.string() },
      kind: "read",
    },
    async ({ doctype, name }, token) => {
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("File"), {
        query: {
          fields: JSON.stringify(["name", "file_name", "file_url", "file_size", "is_private", "creation"]),
          filters: JSON.stringify([
            ["attached_to_doctype", "=", doctype],
            ["attached_to_name", "=", name],
          ]),
          order_by: "creation desc",
          limit_page_length: 100,
        },
      });
      return res.data;
    },
  );

  // ---------- Comments ----------
  defineTool(
    server,
    "add_comment",
    {
      title: "Add a comment",
      description: "Adds an internal comment to a lead or deal timeline (visible to the team, not emailed).",
      input: { reference_doctype: LEAD_OR_DEAL, reference_name: z.string(), content: z.string() },
      kind: "write",
    },
    async (args, token) => callMethod(token, "crm.api.comment.add_comment", args),
  );

  // ---------- WhatsApp ----------
  defineTool(
    server,
    "whatsapp_status",
    {
      title: "WhatsApp status",
      description: "Says whether WhatsApp is installed and enabled in the CRM. Check this before any WhatsApp work.",
      kind: "read",
    },
    async (_a, token) => whatsappReady(token),
  );

  defineTool(
    server,
    "whatsapp_get_messages",
    {
      title: "Get WhatsApp messages",
      description: "Lists WhatsApp messages on a lead or deal.",
      input: { reference_doctype: LEAD_OR_DEAL, reference_name: z.string() },
      kind: "read",
    },
    async (args, token) => {
      await requireWhatsapp(token);
      return callMethod(token, "crm.api.whatsapp.get_whatsapp_messages", args, "GET");
    },
  );

  defineTool(
    server,
    "list_whatsapp_templates",
    {
      title: "List WhatsApp templates",
      description: "Lists WhatsApp message templates with their Meta approval status. Only Approved ones can be sent.",
      input: { status: z.string().optional().describe("e.g. APPROVED, PENDING, REJECTED") },
      kind: "read",
    },
    async ({ status }, token) => {
      await requireWhatsapp(token);
      const res = await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("WhatsApp Templates"), {
        query: {
          fields: JSON.stringify(["*"]),
          filters: status ? JSON.stringify([["status", "=", status]]) : undefined,
          limit_page_length: 200,
        },
      });
      return res.data;
    },
  );

  defineTool(
    server,
    "sync_whatsapp_templates",
    {
      title: "Sync WhatsApp templates from Meta",
      description: "Pulls the latest templates and their approval statuses from Meta.",
      kind: "write",
    },
    async (_a, token) => {
      await requireWhatsapp(token);
      return callMethod(token, "frappe_whatsapp.frappe_whatsapp.doctype.whatsapp_templates.whatsapp_templates.fetch");
    },
  );

  defineTool(
    server,
    "save_whatsapp_template",
    {
      title: "Create or update a WhatsApp template",
      description:
        "Creates (no name) or updates (with name) a WhatsApp Templates record; saving submits it to Meta for approval (status becomes PENDING). Use describe-style fields of the WhatsApp Templates doctype, e.g. template_name, language_code, category (MARKETING/UTILITY), header_type, header, template (body with {{1}} placeholders), sample_values, footer, field_names (lead fields mapped to placeholders). Confirm the content with the user first.",
      input: { name: z.string().optional(), data: z.record(z.string(), z.any()) },
      kind: "send",
    },
    async ({ name, data }, token) => {
      await requireWhatsapp(token);
      const res = name
        ? await frappeRequest<{ data: any }>(token, "PUT", resourcePath("WhatsApp Templates", name), { body: data })
        : await frappeRequest<{ data: any }>(token, "POST", resourcePath("WhatsApp Templates"), { body: data });
      return { name: res.data.name, status: res.data.status };
    },
  );

  defineTool(
    server,
    "prepare_whatsapp",
    {
      title: "Prepare a WhatsApp message (step 1 of 2)",
      description:
        "Builds a WhatsApp message to a lead/deal: free text (optionally with a media file from upload_file), or an approved template. Free text only works if the contact messaged us within the last 24 hours; otherwise use a template. Returns the preview and an approval_id. Show it to the user, wait for their OK, then call send_whatsapp.",
      input: {
        reference_doctype: LEAD_OR_DEAL,
        reference_name: z.string(),
        to: z.string().describe("Phone number; Indian numbers without +91 are accepted"),
        message: z.string().optional().describe("Text, or caption when attaching media"),
        template: z.string().optional().describe("Approved WhatsApp Templates name (instead of message)"),
        attach_file_url: z.string().optional().describe("file_url from upload_file"),
        content_type: z.enum(["text", "image", "document", "video", "audio"]).default("text"),
        reply_to: z.string().optional().describe("WhatsApp Message ID being replied to"),
      },
      kind: "read",
    },
    async (a, token, user) => {
      await requireWhatsapp(token);
      await assertContactable(token, a.reference_doctype, a.reference_name);
      const to = toE164(a.to);
      if (!to) throw new Error(`"${a.to}" is not a valid phone number`);
      if (!a.template && !a.message && !a.attach_file_url) throw new Error("Give a message, a template or a file");
      let templateInfo: any;
      if (a.template) {
        templateInfo = await getDoc(token, "WhatsApp Templates", a.template);
        if (templateInfo.status && String(templateInfo.status).toUpperCase() !== "APPROVED") {
          throw new Error(`Template ${a.template} is ${templateInfo.status}, not APPROVED by Meta yet.`);
        }
      }
      const draft: WhatsappDraft = {
        mode: a.template ? "template" : "text",
        reference_doctype: a.reference_doctype,
        reference_name: a.reference_name,
        to,
        message: a.message,
        template: a.template,
        attach: a.attach_file_url,
        content_type: a.attach_file_url ? a.content_type : "text",
        reply_to: a.reply_to,
      };
      const approval = issueApproval("whatsapp", user, draft, SEND_TTL);
      return {
        approval_id: approval.token,
        expires_at: approval.expires_at,
        to,
        ...(a.template ? { template: a.template, template_body: templateInfo?.template } : { message: a.message }),
        attachment: a.attach_file_url,
        next: "Show this to the user. Only after they approve, call send_whatsapp with approval_id.",
      };
    },
  );

  defineTool(
    server,
    "send_whatsapp",
    {
      title: "Send a prepared WhatsApp message (step 2 of 2)",
      description: "Sends the WhatsApp message prepared by prepare_whatsapp, exactly as previewed. Only after the user approved it.",
      input: { approval_id: z.string() },
      kind: "send",
    },
    async ({ approval_id }, token, user) => {
      const d = consumeApproval<WhatsappDraft>(approval_id, "whatsapp", user);
      await requireWhatsapp(token);
      await assertContactable(token, d.reference_doctype, d.reference_name);
      try {
        if (d.mode === "template") {
          return await callMethod(token, "crm.api.whatsapp.send_whatsapp_template", {
            reference_doctype: d.reference_doctype,
            reference_name: d.reference_name,
            template: d.template,
            to: d.to,
          });
        }
        return await callMethod(token, "crm.api.whatsapp.create_whatsapp_message", {
          reference_doctype: d.reference_doctype,
          reference_name: d.reference_name,
          message: d.message ?? "",
          to: d.to,
          attach: d.attach ?? "",
          reply_to: d.reply_to ?? "",
          content_type: d.content_type ?? "text",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/24|window|re-?engagement|131047/i.test(msg)) {
          throw new Error(`${msg}. The 24-hour window is closed: send an approved template instead.`);
        }
        throw err;
      }
    },
  );
}
