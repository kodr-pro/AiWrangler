import type { Config } from "../../config.js"
import { expandPath } from "../../config.js"
import type { Jev } from "../../jev/client.js"
import type { Corpus, DiffFile, Finding, RepoDiff } from "../../types.js"
import { dirtySet } from "../../git/diff.js"
import { runDeterministic, formatFindings, type DeterministicReport } from "../deterministic/index.js"
import { parseCargoJson, type Diagnostic } from "../deterministic/cargo.js"
import { runCheckBattery, type CheckInput, type SemanticReport, type SemanticVerdict } from "./battery.js"
import { selectRootCause, type RootCauseResult } from "./errors.js"
import { writeDiffSnapshot } from "./snapshot.js"
import { readRuntimeOverridesFile, clearRuntimeOverrides } from "../../overrides.js"
import { LoopTracker, diffFingerprint } from "../../loop.js"
import { Ledger } from "../../ledger.js"
import { join } from "node:path"

export interface CheckOptions extends Omit<CheckInput, "diffs"> {
  cargo?: boolean
  tests?: boolean
  diffs?: RepoDiff[]
  sessionID?: string
}

export type CheckAction = "pass" | "fix" | "human" | "degraded"

export interface CheckReport {
  action: CheckAction
  degraded: boolean
  degradedReason?: string
  deterministic: DeterministicReport
  semantic: SemanticReport | null
  rootCause: RootCauseResult | null
  diagnostics: Diagnostic[]
  loop: { cycle: number; escalated: boolean; reason?: string }
  reasons: string[]
  exitCode: number
  corpusHash: string
  sessionID?: string
  diffHash?: string
  files: { repo: string; path: string; added: number; removed: number }[]
  examinedFiles: number | null
  overridesActive: boolean
  acknowledged: number
}

const SEVERITY_RANK: Record<string, number> = { review: 1, block: 2, human: 3 }

const FILES_SUMMARY_CAP = 200

function fileSummary(diffs: RepoDiff[]): { repo: string; path: string; added: number; removed: number }[] {
  const out: { repo: string; path: string; added: number; removed: number }[] = []
  for (const d of diffs) {
    for (const f of d.files) {
      let added = 0
      let removed = 0
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.kind === "add") added++
          else if (l.kind === "del") removed++
        }
      }
      out.push({ repo: d.repo, path: f.path, added, removed })
      if (out.length >= FILES_SUMMARY_CAP) return out
    }
  }
  return out
}

export async function runCheck(
  config: Config,
  root: string,
  corpus: Corpus,
  jev: Jev,
  opts: CheckOptions,
): Promise<CheckReport> {
  const deterministic = await runDeterministic(config, root, {
    cargo: opts.cargo ?? false,
    tests: opts.tests ?? false,
    ...(opts.diffs ? { diffs: opts.diffs } : {}),
  })
  const diffs = opts.diffs ?? deterministic.repoDiffs
  const ledger = new Ledger(config, root)
  const overridesActive = readRuntimeOverridesFile(config, root) !== null
  if (diffs.length === 0) {
    const entry = {
      ts: new Date().toISOString(),
      kind: "check" as const,
      model: config.model,
      corpusHash: corpus.hash,
      action: "pass",
      findings: [],
      reasons: ["no dirty files in any tracked repo"],
      ...(opts.sessionID !== undefined ? { sessionID: opts.sessionID } : {}),
      files: [],
      examinedFiles: 0,
      overridesActive,
    }
    ledger.append(entry)
    return {
      action: "pass",
      degraded: false,
      deterministic,
      semantic: null,
      rootCause: null,
      diagnostics: [],
      loop: { cycle: 0, escalated: false },
      reasons: ["no dirty files in any tracked repo"],
      exitCode: 0,
      corpusHash: corpus.hash,
      ...(opts.sessionID !== undefined ? { sessionID: opts.sessionID } : {}),
      files: [],
      examinedFiles: 0,
      overridesActive,
      acknowledged: 0,
    }
  }

  const stateDir = expandPath(config.cache.dir, root)
  const tracker = new LoopTracker(join(stateDir, "loop-state.json"))
  const diffText = diffs
    .flatMap((d) => d.files.map((f) => f.path + "\n" + f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text)).join("\n")))
    .join("\n")
  const fingerprint = diffFingerprint(diffText)
  const files = fileSummary(diffs)
  writeDiffSnapshot(config, root, fingerprint, diffs)

  const buildOutput = deterministic.cargo.map((c) => c.steps.map((s) => s.output).join("\n")).join("\n")
  const diagnostics = buildOutput ? parseCargoJson(buildOutput) : []
  const buildFailed = deterministic.cargo.some((c) => c.steps.some((s) => !s.ok))

  let semantic: SemanticReport | null = null
  let degraded = false
  let degradedReason: string | undefined
  const reasons: string[] = []
  let rootCause: RootCauseResult | null = null

  if (buildFailed && config.gates.loop.errorSalience && diagnostics.length > 0) {
    rootCause = await selectRootCause(jev, diagnostics)
    const rc = rootCause.root
    if (rc) {
      reasons.push(
        `build failed; root cause (jev=${rootCause.usedJev}): ${rc.file}:${rc.line} ${rc.message.slice(0, 140)}${rootCause.cascade.length > 0 ? ` (+${rootCause.cascade.length} cascade error(s))` : ""}`,
      )
    }
  }

  if (jev.unavailable()) {
    degraded = true
    degradedReason = jev.unavailable()!.reason
    reasons.push("semantic battery unavailable (" + degradedReason + "); deterministic findings only")
  } else {
    const previousReasons = tracker.history[tracker.history.length - 1]?.topReasons
    try {
      semantic = await runCheckBattery(config, jev, corpus, {
        diffs,
        ...(opts.task !== undefined ? { task: opts.task } : {}),
        ...(opts.claims ? { claims: opts.claims } : {}),
        ...(opts.agentSummary !== undefined ? { agentSummary: opts.agentSummary } : {}),
        ...(opts.toolOutput !== undefined ? { toolOutput: opts.toolOutput } : {}),
        ...(previousReasons && previousReasons.length > 0 ? { previousReasons } : {}),
      })
    } catch (err) {
      degraded = true
      degradedReason = "api-error"
      reasons.push("semantic battery failed (" + (err instanceof Error ? err.message : String(err)) + "); deterministic findings only")
    }
  }

  const allFindings: Finding[] = [...deterministic.findings, ...(semantic?.findings ?? [])]
  const rankOf = (s: Finding["severity"]): number => SEVERITY_RANK[s] ?? 0
  const worst = allFindings.reduce(
    (worstSoFar, f) => (rankOf(f.severity) > rankOf(worstSoFar) ? f.severity : worstSoFar),
    "review" as Finding["severity"],
  )
  const hasBlock = allFindings.some((f) => f.severity === "block")
  const ack = ledger.latestAckFor(fingerprint)
  const ackCovers = (f: Finding): boolean =>
    ack !== null && f.severity === "human" && (ack.rules.includes(f.rule) || ack.rules.includes("*"))
  let acknowledged = 0
  for (const f of allFindings) {
    if (ackCovers(f)) {
      f.acknowledged = true
      acknowledged++
      f.note = `${f.note} [owner-acknowledged ${ack!.ts}]`
    }
  }
  if (acknowledged > 0) {
    reasons.push(
      `human review acknowledged via ledger ack at ${ack!.ts} (${acknowledged} finding(s) satisfied; ack is void if the diff changes)`,
    )
  }
  const hasHuman = allFindings.some((f) => f.severity === "human" && !f.acknowledged)
  const hasReview = allFindings.some((f) => f.severity === "review")

  const vacuous = semantic !== null && semantic.examinedFiles === 0
  if (vacuous) {
    reasons.push(
      "vacuous check: the semantic battery examined 0 eligible files (dirty set contained only skipped content such as superproject root files or submodule pointers); a pass here verifies nothing",
    )
  }

  const loopVerdict = tracker.evaluate(
    fingerprint,
    reasons.length > 0 ? reasons : allFindings.map((f) => `${f.rule} ${f.note}`),
    config.gates.loop.maxCycles,
  )

  let action: CheckAction
  if (loopVerdict.escalate) action = "human"
  else if (degraded && (hasBlock || hasHuman)) action = "degraded"
  else if (hasHuman) action = "human"
  else if (hasBlock || hasReview || buildFailed) action = "fix"
  else action = degraded ? "degraded" : "pass"

  if (loopVerdict.escalate) reasons.unshift(loopVerdict.reason ?? "circuit breaker tripped")
  if (vacuous && action === "pass") {
    action = "degraded"
    degraded = true
    degradedReason = "vacuous"
  }
  void worst

  tracker.record({
    ts: new Date().toISOString(),
    diffHash: fingerprint,
    action,
    topReasons: (reasons.length > 0 ? reasons : allFindings.map((f) => `${f.rule} ${f.note}`)).slice(0, 6),
  })
  if (action === "pass") tracker.reset()

  if (action === "pass" && overridesActive) {
    if (clearRuntimeOverrides(config, root)) {
      ledger.append({
        ts: new Date().toISOString(),
        kind: "override",
        source: "gate",
        changes: { cleared: "expired-on-pass" },
      })
      reasons.push("runtime overrides expired on pass; strict posture restored")
    }
  }

  const effectiveReasons = (reasons.length > 0 ? reasons : allFindings.map((f) => `${f.rule} ${f.note}`)).slice(0, 6)
  ledger.append({
    ts: new Date().toISOString(),
    kind: "check",
    model: config.model,
    corpusHash: corpus.hash,
    action,
    ...(semantic?.usage ? { usage: semantic.usage } : {}),
    findings: allFindings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      subject: `${f.repo}/${f.file}:${f.line ?? "-"}`,
      ...(f.acknowledged ? { acknowledged: true } : {}),
    })),
    ...(semantic ? { verdicts: semantic.verdicts.map((v) => ({ question: v.question, noul: v.value })) } : {}),
    reasons: effectiveReasons,
    ...(opts.sessionID !== undefined ? { sessionID: opts.sessionID } : {}),
    diffHash: fingerprint,
    files,
    examinedFiles: semantic?.examinedFiles ?? null,
    overridesActive,
  })

  const exitCode = action === "pass" ? 0 : action === "fix" ? 1 : action === "human" ? 2 : 3
  return {
    action,
    degraded,
    ...(degradedReason ? { degradedReason } : {}),
    deterministic,
    semantic,
    rootCause,
    diagnostics,
    loop: { cycle: loopVerdict.cycle, escalated: loopVerdict.escalate, ...(loopVerdict.reason ? { reason: loopVerdict.reason } : {}) },
    reasons,
    exitCode,
    corpusHash: corpus.hash,
    ...(opts.sessionID !== undefined ? { sessionID: opts.sessionID } : {}),
    diffHash: fingerprint,
    files,
    examinedFiles: semantic?.examinedFiles ?? null,
    overridesActive,
    acknowledged,
  }
}

export function formatReport(report: CheckReport): string {
  const out: string[] = []
  const label = report.action === "pass" ? "PASS" : report.action === "fix" ? "FIX REQUIRED" : report.action === "human" ? "HUMAN REVIEW" : "DEGRADED / UNVERIFIED"
  out.push(`AIWRANGLER ${label} (exit ${report.exitCode})`)

  const dirtyFiles = report.deterministic.repoDiffs.flatMap((d) => d.files.map((f) => `${d.repo}/${f.path}`))
  out.push(`dirty: ${dirtyFiles.length} file(s) across ${report.deterministic.repoDiffs.length} repo(s)`)
  if (report.examinedFiles !== null) out.push(`examined by semantic battery: ${report.examinedFiles} file(s)`)
  if (report.diffHash) out.push(`diff: ${report.diffHash.slice(0, 16)} (snapshot in .aiwrangler/diffs/)`)
  if (report.overridesActive) out.push("runtime overrides ACTIVE (non-default gates/policy in effect)")

  if (report.deterministic.findings.length > 0) {
    out.push("", "deterministic findings:")
    out.push(formatFindings(report.deterministic.findings))
  }
  if (report.semantic) {
    out.push("", `semantic verdicts (jev, ${report.semantic.usage.inputTokens} in / ${report.semantic.usage.outputTokens} out tokens):`)
    for (const v of report.semantic.verdicts) {
      const conf = v.confidence !== undefined ? ` conf=${v.confidence.toFixed(2)}` : ""
      out.push(`  ${v.question.padEnd(26)} ${v.value.toFixed(2)}${conf}${v.subject ? `  [${v.subject}]` : ""}  ${v.label}`)
    }
    if (report.semantic.findings.length > 0) {
      out.push("", "semantic findings:")
      out.push(formatFindings(report.semantic.findings))
    }
    out.push("", `context pack: ${report.semantic.sections.map((s) => s.id).join(", ") || "(none)"}`)
  }
  if (report.degraded) {
    out.push("", `DEGRADED: ${report.degradedReason ?? "unknown"}: deterministic findings only; semantic layer unverified`)
  }
  if (report.reasons.length > 0) {
    out.push("", "routing reasons:")
    for (const r of report.reasons) out.push(`  - ${r}`)
  }
  if (report.loop.cycle > 1) out.push("", `loop: cycle ${report.loop.cycle}${report.loop.escalated ? ": CIRCUIT BREAKER OPEN" : ""}`)
  return out.join("\n")
}

export { dirtySet }
