// AiWrangler MCP server. Ack and override writes ask the human through MCP
// elicitation (the client UI). If the client has no form elicitation, the
// server falls back to a native desktop dialog. Tool arguments never authorize
// a write by themselves. stdio transport.
//
//   node dist/mcp.js [rootDir]        # rootDir = default gate directory
//   AIWRANGLER_DIR=/path node dist/mcp.js
//
// Per-call `dir` arguments override the startup root, so one server can
// serve multiple workspaces.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { ElicitOutcome } from "./approve.js"
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
  resolveGateDir,
} from "./core.js"
import type { RuntimeOverrides } from "./overrides.js"

const rootArg = process.argv.slice(2).find((a) => !a.startsWith("-"))
if (process.env.AIWRANGLER_DIR === undefined && rootArg !== undefined) {
  process.env.AIWRANGLER_DIR = rootArg
}

const server = new McpServer(
  { name: "aiwrangler", version: "0.1.0" },
  { capabilities: { logging: {} } },
)

const dirArg = z
  .string()
  .optional()
  .describe(
    "absolute path of the workspace/repo root to operate on (config discovery walks up from here). " +
      "Defaults to the server's startup root. Pass the workspace root whenever the server was started elsewhere.",
  )

server.registerTool(
  "wrangler_config",
  {
    description:
      "AiWrangler ground-truth and gate status. Prints the effective configuration (including AIWRANGLER_* env overrides), every gate flag, the active policy thresholds, and the loaded corpus summary (spec sections, review rules, divergence rulings, open questions, one-way doors, whitepaper sections, corpus hash). Use this first in any session to confirm what AiWrangler is enforcing and that the corpus is present.",
    inputSchema: { dir: dirArg },
  },
  async ({ dir }) => ({
    content: [{ type: "text", text: safe(() => configReport(resolveGateDir(dir))) }],
  }),
)

server.registerTool(
  "wrangler_plan",
  {
    description:
      "AiWrangler pre-flight plan gate. Call BEFORE writing any code. Judges the task against the ground-truth corpus (protocol spec, review rules, divergence rulings, open questions, one-way doors) and returns: an ACTION (pass | clarify | human), the reasons, and a ground-truth context pack you MUST honor while implementing. clarify means the task is ambiguous or touches an unresolved question: ask the user before coding. human means a one-way door or steering risk: stop for the owner.",
    inputSchema: {
      task: z.string().describe("the task as given, verbatim if possible"),
      plan: z.string().optional().describe("your implementation plan, if you have one drafted"),
      dir: dirArg,
    },
  },
  async ({ task, plan, dir }) => ({
    content: [{ type: "text", text: await planGate(resolveGateDir(dir), { task, ...(plan ? { plan } : {}) }) }],
  }),
)

server.registerTool(
  "wrangler_check",
  {
    description:
      "AiWrangler post-generation gate. Call BEFORE declaring a task done (and after each substantive revision). Runs deterministic checks (review rules, em dashes, deferred-work discipline, pub-API surface, test discipline) plus a Jev semantic battery (claims vs diff, scope discipline, silent defaults, comment truthfulness, spec contradictions, self-report verification) against the dirty files across all tracked repos. Returns PASS / FIX REQUIRED (with a cited, actionable fix list) / HUMAN REVIEW / DEGRADED. Fix every cited finding and re-run until PASS. Pass agent_summary and tool_output to have your status claims verified too.",
    inputSchema: {
      task: z.string().optional().describe("the task being implemented (improves scope and spec checks)"),
      agent_summary: z.string().optional().describe("your summary of what you did and its status (e.g. 'tests pass, lint clean')"),
      tool_output: z.string().optional().describe("the raw output of the build/test commands you ran, for self-report verification"),
      cargo: z.boolean().optional().describe("also run cargo check on dirty repos"),
      tests: z.boolean().optional().describe("also run cargo test on dirty repos (implies cargo)"),
      dir: dirArg,
    },
  },
  async ({ task, agent_summary, tool_output, cargo, tests, dir }) => ({
    content: [
      {
        type: "text",
        text: await checkGate(resolveGateDir(dir), {
          ...(task ? { task } : {}),
          ...(agent_summary ? { agentSummary: agent_summary } : {}),
          ...(tool_output ? { toolOutput: tool_output } : {}),
          cargo: cargo ?? false,
          tests: tests ?? false,
        }),
      },
    ],
  }),
)

function safe(fn: () => string): string {
  try {
    return fn()
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const decisionSchema = {
  type: "object" as const,
  properties: {
    decision: {
      type: "string" as const,
      title: "Decision",
      description: "Approve records this write. Deny leaves the gate unchanged.",
      enum: ["approve", "deny"],
      enumNames: ["Approve", "Deny"],
    },
  },
  required: ["decision"],
}

/** Ask the MCP client UI. Unsupported clients fall through to the OS dialog. */
async function elicitDecision(summary: string): Promise<ElicitOutcome> {
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: summary,
      requestedSchema: decisionSchema,
    })
    if (result.action === "accept" && result.content?.decision === "approve") return "approve"
    return "deny"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.toLowerCase().includes("does not support") && message.toLowerCase().includes("elicit")) return "unsupported"
    return { error: message }
  }
}

function toolResult(text: string): { isError?: boolean; content: { type: "text"; text: string }[] } {
  return { ...(text.startsWith("aiwrangler:") ? { isError: true } : {}), content: [{ type: "text", text }] }
}

server.registerTool(
  "wrangler_ack",
  {
    description:
      "AiWrangler HUMAN REVIEW. With no rules, note, or diffHash, lists pending human-severity findings and the diff hash. Passing rules requests an acknowledgment. Those arguments do not approve it: the server asks the human with an MCP elicitation prompt (findings, rules, diff hash, and note), or a desktop dialog if this client has no elicitation. Nothing is recorded unless the human approves. Block-severity findings cannot be acked. A diff change voids the ack.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      rules: z.array(z.string()).optional().describe('rule IDs to ask the owner to acknowledge, e.g. ["RULE-10"] or ["*"]. Does not approve by itself.'),
      note: z.string().optional().describe("shown to the owner on the approval prompt and stored if they approve"),
      diffHash: z.string().optional().describe("diff hash from the check report; defaults to the latest recorded gate run. Does not approve by itself."),
      dir: dirArg,
    },
  },
  async ({ rules, note, diffHash, dir }) => {
    if (!isAckWriteAttempt({ rules, note, diffHash })) {
      return { content: [{ type: "text" as const, text: safe(() => listPendingAck(resolveGateDir(dir))) }] }
    }
    const text = await requestHumanAck(
      resolveGateDir(dir),
      { rules: rules ?? [], ...(note !== undefined ? { note } : {}), ...(diffHash !== undefined ? { diffHash } : {}) },
      { by: "mcp", elicit: elicitDecision },
    )
    return toolResult(text)
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`aiwrangler-mcp: ready (root: ${resolveGateDir()})`)
}

server.registerTool(
  "wrangler_override",
  {
    description:
      "AiWrangler runtime overrides. With no set, clear, or note, reports active overrides. Passing set or clear requests a change. Those arguments do not apply it: the server asks the human with an MCP elicitation prompt, or a desktop dialog if this client has no elicitation. Nothing changes unless the human approves. Overrides expire on the next PASS.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      set: z
        .object({
          activePolicy: z.string().optional(),
          egressSemantic: z.boolean().optional(),
          actionThreshold: z.number().min(0).max(1).optional(),
          reviewThreshold: z.number().min(0).max(1).optional(),
          gates: z.record(z.string(), z.boolean()).optional(),
        })
        .optional()
        .describe("overrides to ask the owner to apply. Does not apply them by itself."),
      clear: z.boolean().optional().describe("ask the owner to remove active overrides. Does not clear them by itself."),
      note: z.string().optional().describe("shown to the owner on the approval prompt and stored if they approve"),
      dir: dirArg,
    },
  },
  async ({ set, clear, note, dir }) => {
    if (!isOverrideWriteAttempt({ set, clear, note })) {
      return { content: [{ type: "text" as const, text: safe(() => reportOverrides(resolveGateDir(dir))) }] }
    }
    const text = await requestHumanOverride(
      resolveGateDir(dir),
      {
        ...(set !== undefined ? { set: set as RuntimeOverrides } : {}),
        ...(clear === true ? { clear: true } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      { by: "mcp", elicit: elicitDecision },
    )
    return toolResult(text)
  },
)

server.registerTool(
  "wrangler_loop_reset",
  {
    description:
      "AiWrangler circuit-breaker reset. Call ONLY after the user has decided the repeated findings are not making progress: it clears the retry loop state so the next check starts fresh, and audits a notice. No-op when there is no loop state.",
    inputSchema: { dir: dirArg },
  },
  async ({ dir }) => ({
    content: [{ type: "text", text: safe(() => loopResetGate(resolveGateDir(dir), "mcp")) }],
  }),
)

main().catch((err) => {
  console.error("aiwrangler-mcp: fatal:", err)
  process.exit(1)
})
