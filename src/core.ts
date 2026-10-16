// Client-agnostic gate entry points. Ack and override writes go through
// requestHumanAck / requestHumanOverride, which ask a human channel
// (MCP elicitation, an OS dialog, or the CLI's TTY prompt). Tool arguments
// never authorize a write.
import { loadConfig, findConfigFile, flattenGates, activeThresholds, expandPath } from "./config.js"
import { loadCorpus } from "./groundtruth/corpus.js"
import { sectionsOfKind, effectiveTruth } from "./groundtruth/precedence.js"
import { Jev } from "./jev/client.js"
import { runPlanGate } from "./gates/plan/index.js"
import { runCheck, formatReport } from "./gates/check/run.js"
import { approveOwnerWrite, type ApprovalChannel } from "./approve.js"
import { Ledger, type ApprovalHost, type GateLedgerEntry, type HumanConfirmation } from "./ledger.js"
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

export function isAckWriteAttempt(input: {
  rules?: readonly string[] | undefined
  note?: string | undefined
  diffHash?: string | undefined
}): boolean {
  return input.rules !== undefined || input.note !== undefined || input.diffHash !== undefined
}

export function isOverrideWriteAttempt(input: {
  set?: unknown
  clear?: boolean | undefined
  note?: string | undefined
}): boolean {
  return input.set !== undefined || input.clear === true || input.note !== undefined
}

function latestDiffEntry(ledger: Ledger): GateLedgerEntry | undefined {
  const entries = ledger.read().filter((e): e is GateLedgerEntry => e.kind === "check" || e.kind === "plan")
  return [...entries].reverse().find((e) => e.diffHash !== undefined)
}

/**
 * Read-only list of pending human-severity findings. Safe for MCP and
 * opencode: it never appends an ack.
 */
export function listPendingAck(dir: string): string {
  try {
    const loaded = loadConfig(dir)
    const ledger = new Ledger(loaded.config, loaded.root)
    const latest = latestDiffEntry(ledger)
    if (!latest) {
      return "aiwrangler: no gate run recorded yet; run wrangler_check first"
    }
    const pending = (latest.findings ?? []).filter((f) => f.severity === "human" && !f.acknowledged)
    const out = [`pending human review (check at ${latest.ts}, action: ${latest.action})`, `diffHash: ${latest.diffHash}`]
    if (pending.length === 0) {
      out.push("", "no pending human-severity findings on the latest recorded diff")
      if (latest.action === "human") out.push("(the human verdict came from the semantic layer; re-run wrangler_check to re-confirm)")
    } else {
      const example = pending
        .map((f) => f.rule)
        .slice(0, 8)
        .join(",")
      out.push("", "findings needing the owner's eyes:")
      for (const f of pending) out.push(`  ${f.rule}  ${f.subject}  [${f.severity}]`)
      out.push(
        "",
        "the agent cannot answer the approval prompt. Call wrangler_ack with those rules to ask the owner in the editor,",
        `or the owner can run \`aiwrangler ack --rules ${example}\` in a terminal.`,
        "the ack binds to the diffHash above and is void if the diff changes.",
        "block-severity findings can never be acknowledged; fix them instead.",
      )
    }
    return out.join("\n")
  } catch (err) {
    return `aiwrangler ack error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface PlannedAck {
  ok: true
  rules: string[]
  diffHash: string
  note?: string
  summary: string
}

export type AckPlan = PlannedAck | { ok: false; message: string }

/** Validate an ack and build the human-facing summary. Does not write. */
export function planAck(dir: string, input: { rules: string[]; note?: string; diffHash?: string }): AckPlan {
  try {
    const loaded = loadConfig(dir)
    const ledger = new Ledger(loaded.config, loaded.root)
    const rules = input.rules.filter((r) => typeof r === "string" && r.length > 0)
    if (rules.length === 0) return { ok: false, message: 'aiwrangler: rules must be a non-empty array (use ["*"] to ack all human findings)' }
    let diffHash = input.diffHash
    if (!diffHash) {
      diffHash = latestDiffEntry(ledger)?.diffHash
      if (!diffHash) return { ok: false, message: "aiwrangler: no recorded gate run to ack; run wrangler_check first (or pass diffHash explicitly)" }
    }
    if (!/^[0-9a-f]{16,64}$/.test(diffHash)) return { ok: false, message: "aiwrangler: invalid diffHash" }
    const match = ledger
      .read()
      .filter((e): e is GateLedgerEntry => (e.kind === "check" || e.kind === "plan") && e.diffHash === diffHash)
      .at(-1)
    if (!match) return { ok: false, message: "aiwrangler: diffHash not found in ledger; run wrangler_check for that diff first" }
    const note = input.note && input.note.trim() ? input.note.trim().slice(0, 500) : undefined
    const pending = (match.findings ?? []).filter((f) => f.severity === "human")
    const summary = [
      "AiWrangler: approve acknowledging these HUMAN REVIEW findings?",
      `rules: ${rules.join(", ")}`,
      `diffHash: ${diffHash}`,
      ...(note ? [`note: ${note}`] : []),
      "findings on that diff:",
      ...(pending.length > 0 ? pending.slice(0, 20).map((f) => `  ${f.rule}  ${f.subject}  [${f.severity}]`) : ["  (no human-severity rows stored on that run)"]),
      "The agent cannot answer this prompt. Approve only if you reviewed the diff.",
      "Block-severity findings are never covered. A diff change voids the ack.",
    ].join("\n")
    return { ok: true, rules: rules.slice(0, 50), diffHash, summary, ...(note ? { note } : {}) }
  } catch (err) {
    return { ok: false, message: `aiwrangler ack error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Record an owner acknowledgment bound to a diff hash. `confirmation` comes
 * from a human channel (elicitation, OS dialog, or TTY), never from tool args.
 * Block-severity findings are never covered. A later diff change voids the ack.
 */
export function acknowledgeFindings(
  dir: string,
  input: { rules: string[]; note?: string; diffHash: string; confirmation: HumanConfirmation; by: ApprovalHost },
): string {
  try {
    const planned = planAck(dir, input)
    if (!planned.ok) return planned.message
    const loaded = loadConfig(dir)
    const entry = {
      ts: new Date().toISOString(),
      kind: "ack" as const,
      diffHash: planned.diffHash,
      rules: planned.rules,
      ...(planned.note ? { note: planned.note } : {}),
      by: input.by,
      confirmation: input.confirmation,
    }
    new Ledger(loaded.config, loaded.root).append(entry)
    return [
      `acknowledged: human-severity findings ${JSON.stringify(entry.rules)} for diff ${planned.diffHash.slice(0, 16)}`,
      `recorded by ${input.by} (confirmation: ${input.confirmation})`,
      "the next wrangler_check on this exact diff will pass them with an owner-acknowledged reason.",
      "any diff change voids the ack; block-severity findings are never ackable.",
    ].join("\n")
  } catch (err) {
    return `aiwrangler ack error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Validate, ask the human, then append the ack. Tool arguments alone never write. */
export async function requestHumanAck(
  dir: string,
  input: { rules: string[]; note?: string; diffHash?: string },
  channel: ApprovalChannel & { by: ApprovalHost },
): Promise<string> {
  const planned = planAck(dir, input)
  if (!planned.ok) return planned.message
  const approval = await approveOwnerWrite(planned.summary, channel)
  if (!approval.ok) return approval.message
  return acknowledgeFindings(dir, {
    rules: planned.rules,
    diffHash: planned.diffHash,
    confirmation: approval.confirmation,
    by: channel.by,
    ...(planned.note ? { note: planned.note } : {}),
  })
}

/**
 * Read-only report of active runtime overrides. Safe for MCP and opencode.
 */
export function reportOverrides(dir: string): string {
  try {
    const loaded = loadConfig(dir)
    const file = readRuntimeOverridesFile(loaded.config, loaded.root)
    if (!file) return "runtime overrides: none active (strict defaults in effect). The owner sets them with `aiwrangler override`."
    return [
      "runtime overrides ACTIVE:",
      JSON.stringify(file.overrides, null, 2),
      `created: ${file.createdAt}  expiresOn: ${file.expiresOn}${file.note ? `  note: ${file.note}` : ""}`,
      "they auto-expire on the next PASS verdict; wrangler_config shows the effective state.",
      "to change them, call wrangler_override with set or clear. That asks the owner; it does not apply the change by itself.",
      "the owner can also run `aiwrangler override` in a terminal.",
    ].join("\n")
  } catch (err) {
    return `aiwrangler override error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export type OverridePlan =
  | { ok: false; message: string }
  | { ok: true; kind: "noop"; message: string }
  | { ok: true; kind: "clear"; note?: string; summary: string }
  | { ok: true; kind: "set"; set: RuntimeOverrides; note?: string; summary: string; appliedGates: string[] }

/** Validate an override change and build the human-facing summary. Does not write. */
export function planOverride(dir: string, input: { set?: RuntimeOverrides; clear?: boolean; note?: string }): OverridePlan {
  try {
    if (input.clear && input.set) return { ok: false, message: "aiwrangler: pass only one of set or clear; nothing was changed" }
    const loaded = loadConfig(dir)
    const note = input.note && input.note.trim() ? input.note.trim().slice(0, 300) : undefined
    if (input.clear) {
      if (!readRuntimeOverridesFile(loaded.config, loaded.root)) {
        return { ok: true, kind: "noop", message: "no runtime overrides were active" }
      }
      return {
        ok: true,
        kind: "clear",
        summary: [
          "AiWrangler: clear runtime overrides and restore the strict resting state?",
          ...(note ? [`note: ${note}`] : []),
          "The agent cannot answer this prompt.",
        ].join("\n"),
        ...(note ? { note } : {}),
      }
    }
    if (!input.set) return { ok: false, message: "aiwrangler: override write needs set or clear" }
    let appliedGates: string[] = []
    try {
      appliedGates = applyRuntimeOverrides(loaded.config, input.set).appliedGates
    } catch (err) {
      return { ok: false, message: `aiwrangler: invalid overrides: ${err instanceof Error ? err.message : String(err)}` }
    }
    return {
      ok: true,
      kind: "set",
      set: input.set,
      appliedGates,
      summary: [
        "AiWrangler: apply these runtime overrides? They expire on the next PASS.",
        JSON.stringify(input.set, null, 2),
        ...(note ? [`note: ${note}`] : []),
        "The agent cannot answer this prompt.",
      ].join("\n"),
      ...(note ? { note } : {}),
    }
  } catch (err) {
    return { ok: false, message: `aiwrangler override error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Set or clear runtime overrides after a human confirmation. Writes expire on
 * the next PASS. The ledger records the host and the confirmation method.
 */
export function writeOverrides(
  dir: string,
  input: { set?: RuntimeOverrides; clear?: boolean; note?: string; confirmation: HumanConfirmation; by: ApprovalHost },
): string {
  try {
    const planned = planOverride(dir, input)
    if (!planned.ok) return planned.message
    if (planned.kind === "noop") return planned.message
    const loaded = loadConfig(dir)
    const ledger = new Ledger(loaded.config, loaded.root)
    if (planned.kind === "clear") {
      const existed = clearRuntimeOverrides(loaded.config, loaded.root)
      if (existed) {
        ledger.append({
          ts: new Date().toISOString(),
          kind: "override",
          source: input.by,
          changes: { cleared: "manual" },
          confirmation: input.confirmation,
          ...(planned.note ? { note: planned.note } : {}),
        })
      }
      return existed
        ? `runtime overrides cleared by ${input.by} (confirmation: ${input.confirmation}); strict is the resting state again`
        : "no runtime overrides were active"
    }
    writeRuntimeOverridesFile(loaded.config, loaded.root, {
      version: 1,
      createdAt: new Date().toISOString(),
      ...(planned.note ? { note: planned.note } : {}),
      expiresOn: "pass",
      overrides: planned.set,
    })
    ledger.append({
      ts: new Date().toISOString(),
      kind: "override",
      source: input.by,
      changes: planned.set as unknown as Record<string, unknown>,
      confirmation: input.confirmation,
      ...(planned.note ? { note: planned.note } : {}),
    })
    const gateNote = planned.appliedGates.length > 0 ? `; gates applied: ${planned.appliedGates.join(", ")}` : ""
    return `runtime overrides ACTIVE (expire on next PASS, audited, confirmation: ${input.confirmation})${gateNote}`
  } catch (err) {
    return `aiwrangler override error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Validate, ask the human, then write the override. Tool arguments alone never write. */
export async function requestHumanOverride(
  dir: string,
  input: { set?: RuntimeOverrides; clear?: boolean; note?: string },
  channel: ApprovalChannel & { by: ApprovalHost },
): Promise<string> {
  const planned = planOverride(dir, input)
  if (!planned.ok) return planned.message
  if (planned.kind === "noop") return planned.message
  const approval = await approveOwnerWrite(planned.summary, channel)
  if (!approval.ok) return approval.message
  return writeOverrides(dir, {
    confirmation: approval.confirmation,
    by: channel.by,
    ...(planned.kind === "clear" ? { clear: true } : { set: planned.set }),
    ...(planned.note ? { note: planned.note } : {}),
  })
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


