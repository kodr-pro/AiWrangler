import type { Config } from "../../config.js"
import { dirtySet } from "../../git/diff.js"
import type { CargoStep } from "./cargo.js"
import { cargoCheck } from "./cargo.js"
import { checkRepoDiff } from "./rules.js"
import type { Finding, RepoDiff } from "../../types.js"

export interface DeterministicReport {
  repoDiffs: RepoDiff[]
  findings: Finding[]
  cargo: { repo: string; steps: CargoStep[] }[]
}

export async function runDeterministic(
  config: Config,
  root: string,
  opts: { cargo?: boolean; tests?: boolean; repos?: string[]; diffs?: RepoDiff[] } = {},
): Promise<DeterministicReport> {
  const repoDiffs = opts.diffs ?? dirtySet(config, root)
  const findings: Finding[] = []
  for (const diff of repoDiffs) {
    if (opts.repos && !opts.repos.includes(diff.repo)) continue
    findings.push(...checkRepoDiff(diff, config))
  }

  const cargo: { repo: string; steps: CargoStep[] }[] = []
  if (opts.cargo !== false) {
    for (const diff of repoDiffs) {
      if (opts.repos && !opts.repos.includes(diff.repo)) continue
      const rustTouched = diff.files.some((f) => f.path.endsWith(".rs") || f.path.endsWith("Cargo.toml"))
      if (!rustTouched || diff.repo === "(super)") continue
      const steps = await cargoCheck(diff.repoDir, { tests: opts.tests ?? false })
      cargo.push({ repo: diff.repo, steps })
    }
  }

  return { repoDiffs, findings, cargo }
}

const SEVERITY_ORDER: Record<string, number> = { block: 0, human: 1, review: 2 }

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "no deterministic findings"
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity]! - SEVERITY_ORDER[b.severity]!)
  const bySeverity = new Map<string, Finding[]>()
  for (const f of sorted) bySeverity.set(f.severity, [...(bySeverity.get(f.severity) ?? []), f])
  const out: string[] = []
  for (const [sev, fs] of bySeverity) {
    out.push(`${sev.toUpperCase()} (${fs.length}):`)
    for (const f of fs) {
      out.push(`  ${f.rule} ${f.repo}/${f.file}:${f.line ?? "-"}: ${f.note}`)
      out.push(`    | ${f.evidence}`)
    }
  }
  return out.join("\n")
}
