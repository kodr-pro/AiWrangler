import { tool } from "@opencode-ai/plugin"
import { configReport, planGate, checkGate, ackGate, overrideGate, loopResetGate } from "./core.js"

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
    'AiWrangler human-confirmation flow. Call with NO arguments to list pending human-severity findings (and their diffHash) from the latest gate run. Call with rules (e.g. ["RULE-10"] or ["*"]) ONLY after the user has explicitly reviewed and approved those findings: it records an owner acknowledgment so the next wrangler_check passes the human-severity findings for that exact diff. Never ack without explicit user approval; block-severity findings cannot be acked.',
  args: {
    rules: tool.schema.array(tool.schema.string()).optional().describe('rule IDs to acknowledge, e.g. ["RULE-10"] or ["*"]'),
    note: tool.schema.string().optional().describe("what the user approved and why (recorded in the audit ledger)"),
    diffHash: tool.schema.string().optional().describe("diff hash from the check report; defaults to the latest recorded gate run"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    return ackGate(dir, {
      ...(args.rules ? { rules: args.rules } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(args.diffHash ? { diffHash: args.diffHash } : {}),
      by: "opencode",
    })
  },
})

export const wrangler_override = tool({
  description:
    "AiWrangler runtime override control. Call with NO arguments to report active overrides. Call with set {activePolicy?, egressSemantic?, actionThreshold?, reviewThreshold?, gates: {name: bool}} ONLY after explicit user approval; overrides auto-expire on the next PASS verdict and every change is audited. Call with clear:true to remove them. Strict is always the resting state.",
  args: {
    set: tool.schema
      .object({
        activePolicy: tool.schema.string().optional(),
        egressSemantic: tool.schema.boolean().optional(),
        actionThreshold: tool.schema.number().min(0).max(1).optional(),
        reviewThreshold: tool.schema.number().min(0).max(1).optional(),
        gates: tool.schema.record(tool.schema.string(), tool.schema.boolean()).optional(),
      })
      .optional(),
    clear: tool.schema.boolean().optional(),
    note: tool.schema.string().optional(),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    return overrideGate(dir, {
      ...(args.set ? { set: args.set as import("./overrides.js").RuntimeOverrides } : {}),
      ...(args.clear ? { clear: args.clear } : {}),
      ...(args.note ? { note: args.note } : {}),
      by: "opencode",
    })
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
