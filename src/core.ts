// Client-agnostic gate entry points. Both the opencode tools (src/tools.ts)
// and the MCP server (src/mcp.ts) call these so formatting and ledger
// behavior stay identical across agent hosts.
import { loadConfig, findConfigFile, flattenGates, activeThresholds, expandPath } from "./config.js"
import { loadCorpus } from "./groundtruth/corpus.js"
import { sectionsOfKind, effectiveTruth } from "./groundtruth/precedence.js"
import { Jev } from "./jev/client.js"
import { runPlanGate } from "./gates/plan/index.js"
import { runCheck, formatReport } from "./gates/check/run.js"
import { Ledger, type GateLedgerEntry } from "./ledger.js"
import {
  readRuntimeOverridesFile,
  writeRuntimeOverridesFile,
  clearRuntimeOverrides,
  applyRuntimeOverrides,
  type RuntimeOverrides,
} from "./overrides.js"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const KIND_ORDER = ["spec", "rule", "divergence", "question", "door", "paper", "doc"] as const

/**
 * Resolve the directory a gate should operate on:
 * explicit argument > AIWRANGLER_DIR env > process cwd.
 */
export function resolveGateDir(dir?: string): string {
  return dir ?? process.env.AIWRANGLER_DIR ?? process.cwd()
}

export function configReport(dir: string): string {
  const loaded = loadConfig(dir)
  const corpus = loadCorpus(loaded.config, loaded.root)
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
}

export function formatContextPack(pack: {
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

export async function planGate(
  dir: string,
  input: { task: string; plan?: string; sessionID?: string },
): Promise<string> {
  if (!findConfigFile(dir) && !process.env.AIWRANGLER_CONFIG) {
    return "aiwrangler: no aiwrangler.config.json found for this directory; plan gate inactive"
  }
  try {
    const loaded = loadConfig(dir)
    const corpus = loadCorpus(loaded.config, loaded.root)
    const jev = new Jev(loaded.config, { cacheDir: loaded.root })
    const report = await runPlanGate(loaded.config, jev, corpus, {
      task: input.task,
      ...(input.plan ? { plan: input.plan } : {}),
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
        ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
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
}

export async function checkGate(
  dir: string,
  input: {
    task?: string
    agentSummary?: string
    toolOutput?: string
    cargo?: boolean
    tests?: boolean
    sessionID?: string
  } = {},
): Promise<string> {
  if (!findConfigFile(dir) && !process.env.AIWRANGLER_CONFIG) {
    return "aiwrangler: no aiwrangler.config.json found for this directory; check gate inactive"
  }
  try {
    const loaded = loadConfig(dir)
    const corpus = loadCorpus(loaded.config, loaded.root)
    const jev = new Jev(loaded.config, { cacheDir: loaded.root })
    const report = await runCheck(loaded.config, loaded.root, corpus, jev, {
      ...(input.task ? { task: input.task } : {}),
      ...(input.agentSummary ? { agentSummary: input.agentSummary } : {}),
      ...(input.toolOutput ? { toolOutput: input.toolOutput } : {}),
      cargo: input.cargo || input.tests || false,
      tests: input.tests || false,
      ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
    })
    return formatReport(report)
  } catch (err) {
    return `aiwrangler check gate error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Human-confirmation flow. Two modes:
 *  - list (no rules): report the pending human-severity findings from the
 *    latest gate entry, with the diff hash an ack must reference.
 *  - ack (rules given): append a `kind:"ack"` ledger record so the next
 *    check passes those human findings for that exact diff.
 * Semantics match the ledger ack records; `by` records the host.
 * The caller is responsible for having obtained the owner's explicit
 * approval before acking.
 */
export function ackGate(
  dir: string,
  input: { rules?: string[]; note?: string; diffHash?: string; by?: string } = {},
): string {
  try {
    const loaded = loadConfig(dir)
    const ledger = new Ledger(loaded.config, loaded.root)

    if (!input.rules || input.rules.length === 0) {
      const entries = ledger.read().filter((e): e is GateLedgerEntry => e.kind === "check" || e.kind === "plan")
      const latest = [...entries].reverse().find((e) => e.diffHash !== undefined)
      if (!latest) {
        return "aiwrangler: no gate run recorded yet; run wrangler_check first"
      }
      const pending = (latest.findings ?? []).filter((f) => f.severity === "human" && !f.acknowledged)
      const out = [
        `pending human review (check at ${latest.ts}, action: ${latest.action})`,
        `diffHash: ${latest.diffHash}`,
      ]
      if (pending.length === 0) {
        out.push("", "no pending human-severity findings on the latest recorded diff")
        if (latest.action === "human") out.push("(the human verdict came from the semantic layer; re-run wrangler_check to re-confirm)")
      } else {
        out.push("", "findings needing the owner's eyes:")
        for (const f of pending) out.push(`  ${f.rule}  ${f.subject}  [${f.severity}]`)
        out.push(
          "",
          'to acknowledge after explicit user approval: wrangler_ack with rules (e.g. ["RULE-10"] or ["*"]) and a note.',
          "block-severity findings can never be acknowledged; fix them instead.",
        )
      }
      return out.join("\n")
    }

    const rules = input.rules.filter((r) => typeof r === "string" && r.length > 0)
    if (rules.length === 0) {
      return 'aiwrangler: rules must be a non-empty array (use ["*"] to ack all human findings)'
    }
    let diffHash = input.diffHash
    if (!diffHash) {
      const entries = ledger.read().filter((e): e is GateLedgerEntry => e.kind === "check" || e.kind === "plan")
      const latest = [...entries].reverse().find((e) => e.diffHash !== undefined)
      diffHash = latest?.diffHash
      if (!diffHash) return "aiwrangler: no recorded gate run to ack; run wrangler_check first (or pass diffHash explicitly)"
    }
    if (!/^[0-9a-f]{16,64}$/.test(diffHash)) return "aiwrangler: invalid diffHash"
    const known = ledger
      .read()
      .some((e) => (e.kind === "check" || e.kind === "plan") && e.diffHash === diffHash)
    if (!known) return "aiwrangler: diffHash not found in ledger; run wrangler_check for that diff first"
    const entry = {
      ts: new Date().toISOString(),
      kind: "ack" as const,
      diffHash,
      rules: rules.slice(0, 50),
      ...(input.note && input.note.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
      by: input.by ?? "agent",
    }
    ledger.append(entry)
    return [
      `acknowledged: human-severity findings ${JSON.stringify(entry.rules)} for diff ${diffHash.slice(0, 16)}`,
      "the next wrangler_check on this exact diff will pass them with an owner-acknowledged reason.",
      "any diff change voids the ack; block-severity findings are never ackable.",
    ].join("\n")
  } catch (err) {
    return `aiwrangler ack error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Runtime override control (ported from the retired webui control panel).
 * Modes: no args = report current overrides; set = write validated overrides
 * that expire on the next PASS; clear = remove them. Every write/clear is
 * audited as a ledger `kind:"override"` record.
 */
export function overrideGate(
  dir: string,
  input: { set?: RuntimeOverrides; clear?: boolean; note?: string; by?: string } = {},
): string {
  try {
    const loaded = loadConfig(dir)
    const ledger = new Ledger(loaded.config, loaded.root)
    const by = input.by ?? "agent"

    if (input.clear) {
      const existed = clearRuntimeOverrides(loaded.config, loaded.root)
      if (existed) {
        ledger.append({ ts: new Date().toISOString(), kind: "override", source: by, changes: { cleared: "manual" } })
      }
      return existed ? "runtime overrides cleared; strict is the resting state again" : "no runtime overrides were active"
    }

    if (input.set) {
      let appliedGates: string[] = []
      try {
        appliedGates = applyRuntimeOverrides(loaded.config, input.set).appliedGates
      } catch (err) {
        return `aiwrangler: invalid overrides: ${err instanceof Error ? err.message : String(err)}`
      }
      writeRuntimeOverridesFile(loaded.config, loaded.root, {
        version: 1,
        createdAt: new Date().toISOString(),
        ...(input.note && input.note.trim() ? { note: input.note.trim().slice(0, 300) } : {}),
        expiresOn: "pass",
        overrides: input.set,
      })
      ledger.append({
        ts: new Date().toISOString(),
        kind: "override",
        source: by,
        changes: input.set as unknown as Record<string, unknown>,
      })
      const gateNote = appliedGates.length > 0 ? `; gates applied: ${appliedGates.join(", ")}` : ""
      return `runtime overrides ACTIVE (expire on next PASS, audited)${gateNote}`
    }

    const file = readRuntimeOverridesFile(loaded.config, loaded.root)
    if (!file) return "runtime overrides: none active (strict defaults in effect)"
    return [
      "runtime overrides ACTIVE:",
      JSON.stringify(file.overrides, null, 2),
      `created: ${file.createdAt}  expiresOn: ${file.expiresOn}${file.note ? `  note: ${file.note}` : ""}`,
      "they auto-expire on the next PASS verdict; wrangler_config shows the effective state.",
    ].join("\n")
  } catch (err) {
    return `aiwrangler override error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Circuit-breaker reset (ported from the retired webui control panel).
 * Resets `.aiwrangler/loop-state.json` and audits a notice.
 */
export function loopResetGate(dir: string, by = "agent"): string {
  try {
    const loaded = loadConfig(dir)
    const stateDir = expandPath(loaded.config.cache.dir, loaded.root)
    const loopPath = join(stateDir, "loop-state.json")
    if (!existsSync(loopPath)) return "no loop state to reset"
    writeFileSync(loopPath, JSON.stringify({ cycles: [] }), "utf8")
    new Ledger(loaded.config, loaded.root).append({
      ts: new Date().toISOString(),
      kind: "notice",
      message: `loop state reset via ${by}`,
    })
    return "circuit breaker reset; retry cycles cleared"
  } catch (err) {
    return `aiwrangler loop reset error: ${err instanceof Error ? err.message : String(err)}`
  }
}


