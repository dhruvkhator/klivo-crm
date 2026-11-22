import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { frappeRequest } from "../frappe.js";
import { consumeApproval, issueApproval } from "../lib/approvals.js";
import { callMethod, defineTool, resourcePath } from "./helpers.js";

const FLOW = "Automation Flow";

const stepSchema = z.object({
  step_key: z.string().describe("Unique key, e.g. send_intro"),
  step_type: z.enum(["Action", "Wait", "WaitForEvent", "If"]),
  action_type: z.string().optional().describe("For Action steps, e.g. SendCRMEmail, SetLeadTemperature (see get_automation_capabilities)"),
  target: z.string().default("trigger").describe("'trigger' (the record) or a relationship alias"),
  params: z.record(z.string(), z.any()).default({}).describe(
    'Action params, e.g. SendCRMEmail {"email_template":"Intro"}; Wait {"value":2,"unit":"Days"}; WaitForEvent {"event_name":"crm.prospect_message_received","correlation_key":"{{ doc.name }}","timeout_value":3,"timeout_unit":"Days"}',
  ),
  step_condition: z.string().optional().describe('Python expression for If steps, e.g. doc.status == "Demo Scheduled"'),
  parent_step: z.number().int().default(0).describe("idx (1-based position) of the If step this belongs to; 0 = top level"),
  branch: z.enum(["", "If", "Else"]).default(""),
});

const flowSpec = {
  title: z.string(),
  document_type: z.string().default("CRM Lead"),
  trigger_type: z.enum([
    "Doc Created",
    "Doc Updated",
    "Field Value Changed",
    "Doc Deleted",
    "Date Based",
    "Scheduled",
    "Custom Event",
    "Manual",
  ]),
  trigger_field: z.string().optional().describe("For Field Value Changed, e.g. status"),
  from_value: z.string().optional(),
  to_value: z.string().optional().describe('e.g. "Sequence: Intro" or "Connected: Interested"'),
  custom_event: z.string().optional(),
  date_field: z.string().optional(),
  date_offset: z.number().int().optional(),
  date_direction: z.enum(["Before", "After"]).optional(),
  cron_expression: z.string().optional(),
  filters: z.array(z.tuple([z.string(), z.string(), z.any()])).optional().describe('e.g. [["status","!=","Do Not Contact"]]'),
  condition: z.string().optional().describe("Optional Python expression the record must satisfy"),
  relationships: z.array(z.record(z.string(), z.any())).optional(),
  steps: z.array(stepSchema).min(1),
  stop_on_error: z.boolean().default(true),
};

function toFlowDoc(spec: any) {
  const { steps, filters, relationships, stop_on_error, ...rest } = spec;
  return {
    ...rest,
    filters: filters ? JSON.stringify(filters) : undefined,
    relationships: relationships ? JSON.stringify(relationships) : undefined,
    stop_on_error: stop_on_error ? 1 : 0,
    actions: steps.map((s: any, i: number) => ({
      idx: i + 1,
      step_key: s.step_key,
      step_type: s.step_type,
      action_type: s.action_type,
      target: s.target,
      params: JSON.stringify(s.params ?? {}),
      step_condition: s.step_condition,
      parent_step: s.parent_step,
      branch: s.branch,
    })),
  };
}

/** M9: email/follow-up sequences on the CRM v16 automation engine. */
export function registerAutomationTools(server: McpServer) {
  defineTool(
    server,
    "get_automation_capabilities",
    {
      title: "Automation building blocks",
      description:
        "Lists what flows can use for a record type: trigger types, events (e.g. prospect replied), fields, and action types with their params. Read this before create_automation_flow.",
      input: { doctype: z.string().default("CRM Lead"), trigger_type: z.string().optional() },
      kind: "read",
    },
    async ({ doctype, trigger_type }, token) =>
      callMethod(token, "frappe.automation_engine.api.get_automation_capabilities", { doctype, trigger_type }, "GET"),
  );

  defineTool(
    server,
    "list_automation_flows",
    {
      title: "List automation flows (sequences)",
      description: "Lists automation flows with trigger, record type and whether they are enabled.",
      kind: "read",
    },
    async (_a, token) =>
      (
        await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath(FLOW), {
          query: {
            fields: JSON.stringify(["name", "title", "document_type", "trigger_type", "trigger_field", "to_value", "enabled", "disabled_reason"]),
            order_by: "modified desc",
            limit_page_length: 200,
          },
        })
      ).data,
  );

  defineTool(
    server,
    "get_automation_flow",
    {
      title: "Get an automation flow",
      description: "Returns one flow with its trigger, filters and all steps.",
      input: { name: z.string() },
      kind: "read",
    },
    async ({ name }, token) => (await frappeRequest<{ data: unknown }>(token, "GET", resourcePath(FLOW, name))).data,
  );

  defineTool(
    server,
    "create_automation_flow",
    {
      title: "Create an automation flow (sequence)",
      description:
        'Creates a flow, always saved DISABLED. Example sequence: trigger Field Value Changed on status to "Sequence: Intro"; steps: SendCRMEmail(intro) -> WaitForEvent(prospect reply, 2 days) -> If replied: stop / Else: SendCRMEmail(follow-up 1) -> Wait 3 days -> SendCRMEmail(follow-up 2). Add filters so leads marked Do Not Contact never run. Test with trial_run_flow, then enable with prepare_flow_enable + enable_flow.',
      input: flowSpec,
      kind: "write",
    },
    async (spec, token) => {
      const res = await frappeRequest<{ data: any }>(token, "POST", resourcePath(FLOW), {
        body: { ...toFlowDoc(spec), enabled: 0 },
      });
      return { name: res.data.name, title: res.data.title, enabled: false, steps: res.data.actions?.length };
    },
  );

  defineTool(
    server,
    "update_automation_flow",
    {
      title: "Update an automation flow",
      description: "Replaces a flow's trigger, filters and steps with the given spec. Its enabled state is kept.",
      input: { name: z.string(), ...flowSpec },
      kind: "write",
    },
    async ({ name, ...spec }, token) => {
      const res = await frappeRequest<{ data: any }>(token, "PUT", resourcePath(FLOW, name), { body: toFlowDoc(spec) });
      return { name: res.data.name, enabled: !!res.data.enabled, steps: res.data.actions?.length };
    },
  );

  defineTool(
    server,
    "trial_run_flow",
    {
      title: "Dry-run a flow on one record",
      description:
        "Runs a flow against one lead/deal and rolls everything back: shows which steps would run and what they would do, without sending or changing anything. branch_overrides forces an If step's arm, e.g. {\"3\":\"Else\"}.",
      input: {
        name: z.string(),
        record: z.string().optional().describe("Lead/deal ID"),
        branch_overrides: z.record(z.string(), z.enum(["If", "Else"])).optional(),
      },
      kind: "read",
    },
    async ({ name, record, branch_overrides }, token) =>
      callMethod(token, "frappe.automation_engine.api.trial_run", {
        automation: name,
        docname: record,
        branch_overrides: branch_overrides ? JSON.stringify(branch_overrides) : undefined,
      }),
  );

  defineTool(
    server,
    "prepare_flow_enable",
    {
      title: "Prepare to enable a flow (step 1 of 2)",
      description:
        "Enabling a flow makes it send real emails automatically. Returns the flow summary and a confirm_token; show it to the user and wait for their OK, then call enable_flow.",
      input: { name: z.string() },
      kind: "read",
    },
    async ({ name }, token, user) => {
      const flow = (await frappeRequest<{ data: any }>(token, "GET", resourcePath(FLOW, name))).data;
      const t = issueApproval("flow", user, { name }, 30 * 60);
      return {
        confirm_token: t.token,
        title: flow.title,
        trigger: { type: flow.trigger_type, doctype: flow.document_type, field: flow.trigger_field, to: flow.to_value },
        filters: flow.filters,
        steps: (flow.actions ?? []).map((s: any) => `${s.idx}. ${s.step_type}${s.action_type ? ` ${s.action_type}` : ""} ${s.params ?? ""}`),
      };
    },
  );

  defineTool(
    server,
    "enable_flow",
    {
      title: "Enable a flow (step 2 of 2)",
      description: "Turns on the flow approved via prepare_flow_enable.",
      input: { confirm_token: z.string() },
      kind: "send",
    },
    async ({ confirm_token }, token, user) => {
      const { name } = consumeApproval<{ name: string }>(confirm_token, "flow", user);
      await frappeRequest(token, "PUT", resourcePath(FLOW, name), { body: { enabled: 1 } });
      return { name, enabled: true };
    },
  );

  defineTool(
    server,
    "disable_flow",
    {
      title: "Disable a flow",
      description: "Turns a flow off immediately (no approval needed). Runs already waiting may still finish their current step.",
      input: { name: z.string() },
      kind: "write",
    },
    async ({ name }, token) => {
      await frappeRequest(token, "PUT", resourcePath(FLOW, name), { body: { enabled: 0 } });
      return { name, enabled: false };
    },
  );

  defineTool(
    server,
    "list_flow_runs",
    {
      title: "List flow runs",
      description:
        "Shows sequence runs: for one lead/deal (record) which flows ran and their status, or for one flow its recent runs. Status shows whether a run is waiting, finished or failed.",
      input: {
        record_doctype: z.enum(["CRM Lead", "CRM Deal"]).optional(),
        record: z.string().optional(),
        flow: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      kind: "read",
    },
    async ({ record_doctype, record, flow, limit }, token) => {
      if (record) {
        return callMethod(
          token,
          "frappe.automation_engine.api.get_runs",
          { reference_doctype: record_doctype ?? "CRM Lead", reference_name: record },
          "GET",
        );
      }
      if (!flow) throw new Error("Give a record or a flow");
      return (
        await frappeRequest<{ data: unknown[] }>(token, "GET", resourcePath("Automation Run"), {
          query: {
            fields: JSON.stringify(["name", "reference_doctype", "reference_name", "status", "started_at", "ended_at", "error_summary"]),
            filters: JSON.stringify([["automation", "=", flow]]),
            order_by: "creation desc",
            limit_page_length: limit,
          },
        })
      ).data;
    },
  );
}
