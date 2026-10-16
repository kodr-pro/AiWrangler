// AiWrangler MCP server: exposes the gates (config / plan / check / ack /
// override / loop-reset) to any MCP client (Cursor, Claude Code, Windsurf,
// ...). stdio transport.
//
//   node dist/mcp.js [rootDir]        # rootDir = default gate directory
//   AIWRANGLER_DIR=/path node dist/mcp.js
//
// Per-call `dir` arguments override the startup root, so one server can
// serve multiple workspaces.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { configReport, planGate, checkGate, ackGate, overrideGate, loopResetGate, resolveGateDir } from "./core.js"

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

server.registerTool(
  "wrangler_ack",
  {
    description:
      'AiWrangler human-confirmation flow. Call with NO arguments to list the pending human-severity findings (and their diffHash) from the latest gate run. Call with rules (e.g. ["RULE-10"] or ["*"]) ONLY after the user has explicitly reviewed and approved those findings in conversation: it records an owner acknowledgment so the next wrangler_check passes the human-severity findings for that exact diff. Never ack without explicit user approval; never ack to skip work; block-severity findings cannot be acked.',
    inputSchema: {
      rules: z.array(z.string()).optional().describe('rule IDs to acknowledge, e.g. ["RULE-10"] or ["*"] for all human findings'),
      note: z.string().optional().describe("what the user approved and why (recorded in the audit ledger)"),
      diffHash: z.string().optional().describe("diff hash from the check report; defaults to the latest recorded gate run"),
      dir: dirArg,
    },
  },
  async ({ rules, note, diffHash, dir }) => ({
    content: [
      {
        type: "text",
        text: safe(() => ackGate(resolveGateDir(dir), { ...(rules ? { rules } : {}), ...(note ? { note } : {}), ...(diffHash ? { diffHash } : {}), by: "mcp" })),
      },
    ],
  }),
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
      "AiWrangler runtime override control. Call with NO arguments to report the active overrides. Call with set {activePolicy?, egressSemantic?, actionThreshold?, reviewThreshold?, gates: {name: bool}} to change the effective gates/policy, ONLY after explicit user approval; overrides auto-expire on the next PASS verdict and every change is audited in the ledger. Call with clear: true to remove them. Strict is always the resting state.",
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
        .describe("the overrides to apply (validated; unknown policies/gates are rejected)"),
      clear: z.boolean().optional().describe("remove any active overrides"),
      note: z.string().optional().describe("why the user approved this override (audited)"),
      dir: dirArg,
    },
  },
  async ({ set, clear, note, dir }) => ({
    content: [
      {
        type: "text",
        text: safe(() => overrideGate(resolveGateDir(dir), { ...(set ? { set } : {}), ...(clear ? { clear } : {}), ...(note ? { note } : {}), by: "mcp" })),
      },
    ],
  }),
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
