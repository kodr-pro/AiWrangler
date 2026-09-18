import type { Jev } from "../../jev/client.js"
import { choice } from "../../jev/questions.js"
import type { Diagnostic } from "../deterministic/cargo.js"

export interface RootCauseResult {
  root: Diagnostic | null
  cascade: Diagnostic[]
  usedJev: boolean
}

export function selectRootCauseHeuristic(diags: Diagnostic[]): RootCauseResult {
  const errors = diags.filter((d) => d.severity === "error")
  if (errors.length === 0) return { root: diags[0] ?? null, cascade: [], usedJev: false }
  const root = errors.find((d) => d.isRootCauseCandidate) ?? errors[0]!
  return {
    root,
    cascade: errors.filter((d) => d !== root),
    usedJev: false,
  }
}

export async function selectRootCause(jev: Jev, diags: Diagnostic[]): Promise<RootCauseResult> {
  const errors = diags.filter((d) => d.severity === "error")
  if (errors.length <= 1) return { root: errors[0] ?? null, cascade: [], usedJev: false }
  if (jev.unavailable()) return selectRootCauseHeuristic(diags)

  const candidates = errors.slice(0, 6)
  const state = {
    candidates: candidates.map((d, i) => ({
      index: i,
      file: d.file,
      line: d.line,
      message: d.message.slice(0, 240),
    })),
  }
  const criteria: Record<string, string | object> = {}
  const questions: Record<string, unknown> = {}
  candidates.forEach((_, i) => {
    criteria[`cand_${i}`] = {
      what: `Root cause is \`candidates[${i}].message\` in \`candidates[${i}].file\``,
      not_for: "This error is a consequence of another candidate and would disappear once that one is fixed",
    }
  })
  criteria["none_root"] = "None is clearly the root cause; they look independent"
  questions.root_cause = choice(
    {
      question:
        "Which single `candidates` entry is the root cause that the other errors follow from? Fixing it first is the change the compiler output asks for.",
      focus: "Pick the error that best explains the others; import-resolution and name-resolution errors usually follow from an earlier failure.",
    },
    criteria,
  )

  const res = await jev.ask(state, questions)
  const a = res.answers["root_cause"]
  if (!a || a.kind !== "choice" || !a.choice.startsWith("cand_")) {
    return selectRootCauseHeuristic(diags)
  }
  const idx = Number(a.choice.slice(5))
  const root = candidates[idx] ?? null
  return {
    root,
    cascade: errors.filter((d) => d !== root),
    usedJev: true,
  }
}
