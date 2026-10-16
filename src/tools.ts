import { tool } from "@opencode-ai/plugin"
import {
  ACK_WRITE_REFUSAL,
  OVERRIDE_WRITE_REFUSAL,
  configReport,
  planGate,
  checkGate,
  isAckWriteAttempt,
  isOverrideWriteAttempt,
  listPendingAck,
  reportOverrides,
  loopResetGate,
} from "./core.js"

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
    "AiWrangler read-only HUMAN REVIEW list. Reports pending human-severity findings and the diff hash from the latest gate run. This tool cannot acknowledge findings. Approval is an out-of-band owner step: run `aiwrangler ack` in a terminal. Passing rules, note, or diffHash is rejected and records nothing.",
  args: {
    rules: tool.schema.array(tool.schema.string()).optional().describe("rejected; acknowledgments are not available to the agent"),
    note: tool.schema.string().optional().describe("rejected; acknowledgments are not available to the agent"),
    diffHash: tool.schema.string().optional().describe("rejected; acknowledgments are not available to the agent"),
  },
  async execute(args, ctx) {
    if (isAckWriteAttempt(args)) return ACK_WRITE_REFUSAL
    const dir = ctx.directory ?? process.cwd()
    return listPendingAck(dir)
  },
})

export const wrangler_override = tool({
  description:
    "AiWrangler read-only override report. With no write arguments, reports active runtime overrides. This tool cannot set or clear overrides. The owner runs `aiwrangler override` in a terminal. Passing set, clear, or note is rejected and changes nothing. Overrides a human sets still expire on the next PASS.",
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
      .describe("rejected; override changes are not available to the agent"),
    clear: tool.schema.boolean().optional().describe("rejected; override changes are not available to the agent"),
    note: tool.schema.string().optional().describe("rejected; override changes are not available to the agent"),
  },
  async execute(args, ctx) {
    if (isOverrideWriteAttempt(args)) return OVERRIDE_WRITE_REFUSAL
    const dir = ctx.directory ?? process.cwd()
    return reportOverrides(dir)
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
