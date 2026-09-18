import { tool } from "@opencode-ai/plugin"
import { loadConfig, findConfigFile, flattenGates, activeThresholds } from "./config.js"
import { loadCorpus } from "./groundtruth/corpus.js"
import { sectionsOfKind, effectiveTruth } from "./groundtruth/precedence.js"
import { Jev } from "./jev/client.js"
import { runPlanGate } from "./gates/plan/index.js"
import { runCheck, formatReport } from "./gates/check/run.js"
import { Ledger } from "./ledger.js"

const KIND_ORDER = ["spec", "rule", "divergence", "question", "door", "paper", "doc"] as const

export const wrangler_config = tool({
  description:
    "AiWrangler ground-truth and gate status. Prints the effective configuration (including AIWRANGLER_* env overrides), every gate flag, the active policy thresholds, and the loaded corpus summary (spec sections, review rules, divergence rulings, open questions, one-way doors, whitepaper sections, corpus hash). Use this first in any session to confirm what AiWrangler is enforcing and that the corpus is present.",
  args: {},
  async execute(_args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    try {
      const { loaded, corpus } = (() => {
        const loaded = loadConfig(dir)
        return { loaded, corpus: loadCorpus(loaded.config, loaded.root) }
      })()
      const flags = flattenGates(loaded.config)
      const thresholds = activeThresholds(loaded.config)
      const counts = KIND_ORDER.map((kind) => `${kind}=${sectionsOfKind(corpus, kind).length}`)
      const ruled = effectiveTruth(corpus)
      const out = [
        `config: ${loaded.path ?? "(defaults)"} [${loaded.source}]`,
        `model: ${loaded.config.model}  policy: ${loaded.config.activePolicy} (act>=${thresholds.actionThreshold}, review>=${thresholds.reviewThreshold})`,
        `egress: semantic=${loaded.config.egress.semantic ? "ON (task/diff/spec text goes to api.typesafe.ai)" : "OFF (deterministic only)"}`,
        "",
        "gates:",
        ...[...flags.entries()].map(([path, on]) => `  ${on ? "on " : "off"}  ${path}`),
        "",
        `corpus: ${counts.join("  ")}  ruled=${ruled.length}  hash=${corpus.hash.slice(0, 12)}`,
        ...corpus.sources.map((s) => `  ${s.path} (${s.hash.slice(0, 8)})`),
        ...(corpus.sections.length === 0 ? ["  (no ground truth configured; point corpus paths in aiwrangler.config.json at your spec, rules, and rulings)"] : []),
      ]
      if (loaded.config.egress.semantic && loaded.config.egress.warnOncePerSession) {
        out.push("", "NOTE: the semantic gate sends task/diff/spec text to api.typesafe.ai. Set AIWRANGLER_EGRESS=off to disable.")
      }
      return out.join("\n")
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})

function formatContextPack(pack: {
  sections: { id: string; title: string; text: string }[]
  rulings: { id: string; title: string; text: string; ruling?: string }[]
  openItems: { id: string; title: string; text: string }[]
  doors: { id: string; title: string; text: string }[]
}): string {
  const out: string[] = []
  out.push("GROUND-TRUTH CONTEXT PACK (cite these IDs; honor them while implementing):")
  if (pack.sections.length > 0) {
    out.push("", "governing sections:")
    for (const s of pack.sections) out.push(`  [${s.id}] ${s.title}\n    ${s.text.replace(/\s+/g, " ").slice(0, 600)}`)
  }
  if (pack.rulings.length > 0) {
    out.push("", "recorded rulings (these override the paper and spec):")
    for (const r of pack.rulings) out.push(`  [${r.id}] ${r.title}\n    ${(r.ruling ?? r.text).replace(/\s+/g, " ").slice(0, 400)}`)
  }
  if (pack.doors.length > 0) {
    out.push("", "one-way doors / launch gates (never change without the owner):")
    for (const d of pack.doors) out.push(`  [${d.id}] ${d.title}\n    ${d.text.replace(/\s+/g, " ").slice(0, 400)}`)
  }
  if (pack.openItems.length > 0) {
    out.push("", "open items in this task's area (do not pick a side; ask the user if it blocks you):")
    for (const o of pack.openItems) out.push(`  [${o.id}] ${o.title}\n    ${o.text.replace(/\s+/g, " ").slice(0, 400)}`)
  }
  return out.join("\n")
}

export const wrangler_plan = tool({
  description:
    "AiWrangler pre-flight plan gate. Call BEFORE writing any code. Judges the task against the ground-truth corpus (protocol spec, review rules, divergence rulings, open questions, one-way doors) and returns: an ACTION (pass | clarify | human), the reasons, and a ground-truth context pack you MUST honor while implementing. clarify means the task is ambiguous or touches an unresolved question: ask the user before coding. human means a one-way door or steering risk: stop for the owner.",
  args: {
    task: tool.schema.string().describe("the task as given, verbatim if possible"),
    plan: tool.schema.string().optional().describe("your implementation plan, if you have one drafted"),
  },
  async execute(args, ctx) {
    const dir = ctx.directory ?? process.cwd()
    if (!findConfigFile(dir) && !process.env.AIWRANGLER_CONFIG) {
      return "aiwrangler: no aiwrangler.config.json found for this directory; plan gate inactive"
    }
    try {
      const loaded = loadConfig(dir)
      const corpus = loadCorpus(loaded.config, loaded.root)
      const jev = new Jev(loaded.config, { cacheDir: loaded.root })
      const report = await runPlanGate(loaded.config, jev, corpus, {
        task: args.task,
        ...(args.plan ? { plan: args.plan } : {}),
      })
      try {
        new Ledger(loaded.config, loaded.root).append({
          ts: new Date().toISOString(),
          kind: "plan",
          model: loaded.config.model,
          corpusHash: corpus.hash,
          action: report.action,
          ...(report.usage ? { usage: report.usage } : {}),
          findings: [],
          ...(report.verdicts.length > 0 ? { verdicts: report.verdicts.map((v) => ({ question: v.question, noul: v.noul })) } : {}),
          reasons: report.reasons,
          ...(ctx.sessionID !== undefined ? { sessionID: ctx.sessionID } : {}),
          overridesActive: loaded.overrides !== null,
        })
      } catch {
        /* ledger append is best-effort; the gate result is authoritative */
      }
      const out = [
        `AIWRANGLER PLAN: ${report.action.toUpperCase()}${report.degraded ? " (degraded: " + report.degradedReason + ")" : ""}`,
      ]
      if (report.verdicts.length > 0) {
        out.push("", "verdicts:")
        for (const v of report.verdicts) out.push(`  ${v.question.padEnd(22)} ${v.noul.toFixed(2)} ${v.interpretation}${v.subject ? " [" + v.subject + "]" : ""}  ${v.label}`)
      }
      if (report.reasons.length > 0) {
        out.push("", "reasons:")
        for (const r of report.reasons) out.push(`  - ${r}`)
      }
      if (report.action === "clarify") out.push("", "Ask the user to resolve the flagged items before writing code.")
      if (report.action === "human") out.push("", "STOP: this task touches a decided one-way door or flagged steering text; the owner must decide.")
      out.push("", formatContextPack(report.contextPack))
      return out.join("\n")
    } catch (err) {
      return `aiwrangler plan gate error: ${err instanceof Error ? err.message : String(err)}`
    }
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
    if (!findConfigFile(dir) && !process.env.AIWRANGLER_CONFIG) {
      return "aiwrangler: no aiwrangler.config.json found for this directory; check gate inactive"
    }
    try {
      const loaded = loadConfig(dir)
      const corpus = loadCorpus(loaded.config, loaded.root)
      const jev = new Jev(loaded.config, { cacheDir: loaded.root })
      const report = await runCheck(loaded.config, loaded.root, corpus, jev, {
        ...(args.task ? { task: args.task } : {}),
        ...(args.agent_summary ? { agentSummary: args.agent_summary } : {}),
        ...(args.tool_output ? { toolOutput: args.tool_output } : {}),
        cargo: args.cargo || args.tests || false,
        tests: args.tests || false,
        ...(ctx.sessionID !== undefined ? { sessionID: ctx.sessionID } : {}),
      })
      return formatReport(report)
    } catch (err) {
      return `aiwrangler check gate error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})
