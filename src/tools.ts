import { tool } from "@opencode-ai/plugin"
import {
  configReport,
  planGate,
  checkGate,
  isAckWriteAttempt,
  isOverrideWriteAttempt,
  listPendingAck,
  reportOverrides,
  requestHumanAck,
  requestHumanOverride,
  loopResetGate,
} from "./core.js"
import type { RuntimeOverrides } from "./overrides.js"

export const wrangler_config = tool({
  description:
    "AiWrangler ground-truth and gate status. Prints the effective configuration (including AIWRANGLER_* env overrides), every gate flag, the active policy thresholds, and the loaded corpus summary (spec sections, review rules, divergence rulings, open questions, one-way doors, whitepaper sections, corpus hash). Use this first in any session to confirm what AiWrangler is enforcing and that the corpus is present.",
  args: {},
  async execute(_args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    try {
      return configReport(dir)
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})

export const wrangler_plan = tool({
  description:
    "AiWrangler pre-flight plan gate. Call BEFORE writing any code. Judges the task against the ground-truth corpus (protocol spec, review rules, divergence rulings, open questions, one-way doors) and returns: an ACTION (pass | clarify | human), the reasons, and a ground-truth context pack you MUST honor while implementing. clarify means the task is ambiguous or touches an unresolved question: ask the user before coding. human means a one-way door or steering risk: stop for the owner.",
  args: {
    task: tool.schema.string().describe("the task as given, verbatim if possible"),
    plan: tool.schema.string().optional().describe("your implementation plan, if you have one drafted"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    return planGate(dir, {
      task: args.task,
      ...(args.plan ? { plan: args.plan } : {}),
      ...(ctx.sessionID !== undefined ? { sessionID: ctx.sessionID } : {}),
    })
  },
})

export const wrangler_check = tool({
  description:
    "AiWrangler post-generation gate. Call BEFORE declaring a task done (and after each substantive revision). Runs deterministic checks (review rules, em dashes, deferred-work discipline, pub-API surface, test discipline) plus a Jev semantic battery (claims vs diff, scope discipline, silent defaults, comment truthfulness, spec contradictions, self-report verification) against the dirty files across all tracked repos. Returns PASS / FIX REQUIRED (with a cited, actionable fix list) / HUMAN REVIEW / DEGRADED. Fix every cited finding and re-run until PASS. Pass agent_summary and tool_output to have your status claims verified too.",
  args: {
    task: tool.schema.string().optional().describe("the task being implemented (improves scope and spec checks)"),
    agent_summary: tool.schema.string().optional().describe("your summary of what you did and its status (e.g. 'tests pass, lint clean')"),
    tool_output: tool.schema.string().optional().describe("the raw output of the build/test commands you ran, for self-report verification"),
    cargo: tool.schema.boolean().default(false).describe("also run cargo check on dirty repos"),
    tests: tool.schema.boolean().default(false).describe("also run cargo test on dirty repos (implies cargo)"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    return checkGate(dir, {
      ...(args.task ? { task: args.task } : {}),
      ...(args.agent_summary ? { agentSummary: args.agent_summary } : {}),
      ...(args.tool_output ? { toolOutput: args.tool_output } : {}),
      cargo: args.cargo || args.tests || false,
      tests: args.tests || false,
      ...(ctx.sessionID !== undefined ? { sessionID: ctx.sessionID } : {}),
    })
  },
})

export const wrangler_ack = tool({
  description:
    "AiWrangler HUMAN REVIEW. With no rules, note, or diffHash, lists pending human-severity findings and the diff hash. Passing rules requests an acknowledgment. Those arguments do not approve it: this native tool has no MCP elicitation channel, so it shows a desktop dialog. Nothing is recorded unless the owner approves. Prefer the MCP server inside opencode, which can elicit in the editor. Block-severity findings cannot be acked.",
  args: {
    rules: tool.schema.array(tool.schema.string()).optional().describe("rule IDs to ask the owner to acknowledge. Does not approve by itself."),
    note: tool.schema.string().optional().describe("shown to the owner on the approval prompt and stored if they approve"),
    diffHash: tool.schema.string().optional().describe("diff hash from the check report; defaults to the latest recorded gate run"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    if (!isAckWriteAttempt(args)) return listPendingAck(dir)
    return requestHumanAck(
      dir,
      { rules: args.rules ?? [], ...(args.note !== undefined ? { note: args.note } : {}), ...(args.diffHash !== undefined ? { diffHash: args.diffHash } : {}) },
      { by: "opencode" },
    )
  },
})

export const wrangler_override = tool({
  description:
    "AiWrangler runtime overrides. With no set, clear, or note, reports active overrides. Passing set or clear requests a change. Those arguments do not apply it: this native tool shows a desktop dialog because it has no MCP elicitation channel. Nothing changes unless the owner approves. Prefer the MCP server inside opencode. Overrides expire on the next PASS.",
  args: {
    set: tool.schema
      .object({
        activePolicy: tool.schema.string().optional(),
        egressSemantic: tool.schema.boolean().optional(),
        actionThreshold: tool.schema.number().min(0).max(1).optional(),
        reviewThreshold: tool.schema.number().min(0).max(1).optional(),
        gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional(),
      })
      .optional()
      .describe("overrides to ask the owner to apply. Does not apply them by itself."),
    clear: tool.schema.boolean().optional().describe("ask the owner to remove active overrides. Does not clear them by itself."),
    note: tool.schema.string().optional().describe("shown to the owner on the approval prompt and stored if they approve"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    if (!isOverrideWriteAttempt(args)) return reportOverrides(dir)
    return requestHumanOverride(
      dir,
      {
        ...(args.set !== undefined ? { set: args.set as RuntimeOverrides } : {}),
        ...(args.clear === true ? { clear: true } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
      },
      { by: "opencode" },
    )
  },
})

export const wrangler_loop_reset = tool({
  description:
    "AiWrangler circuit-breaker reset. Call ONLY after the user has decided repeated findings are not making progress: clears the retry loop state so the next check starts fresh, and audits a notice. No-op when there is no loop state.",
  args: {},
  async execute(_args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    return loopResetGate(dir, "opencode")
  },
})
