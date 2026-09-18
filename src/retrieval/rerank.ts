import type { Config } from "../config.js"
import type { Jev } from "../jev/client.js"
import { noul } from "../jev/questions.js"
import type { CorpusSection } from "../types.js"
import { excerpt, type Scored } from "./shortlist.js"

export interface RerankResult {
  ranked: CorpusSection[]
  relevance: Map<string, number>
  usedJev: boolean
}

export async function rerank(
  jev: Jev,
  config: Config,
  query: string,
  candidates: Scored[],
): Promise<RerankResult> {
  const topK = config.gates.retrieval.topK
  if (candidates.length === 0) return { ranked: [], relevance: new Map(), usedJev: false }

  if (!config.gates.retrieval.rerank || jev.unavailable()) {
    return {
      ranked: candidates.slice(0, topK).map((c) => c.section),
      relevance: new Map(),
      usedJev: false,
    }
  }

  const maxLex = candidates[0]!.score || 1
  const state = {
    query,
    candidates: candidates.map((c, i) => ({
      id: c.section.id,
      title: c.section.title,
      excerpt: excerpt(c.section.text, 320),
      index: i,
    })),
  }
  const questions: Record<string, unknown> = {}
  for (let i = 0; i < candidates.length; i++) {
    questions[`rel_${i}`] = noul(
      {
        question: `Does \`candidates[${i}].excerpt\` state requirements, rules, or decisions that apply to the work described in \`query\`?`,
        focus: "Judge whether this section governs, constrains, or describes the same subject as the query.",
      },
      "The section states requirements, rules, or decisions that the work in the query must satisfy or is directly part of",
      "The section concerns a different subject than the query and imposes nothing on it",
    )
  }

  const res = await jev.ask(state, questions)
  const relevance = new Map<string, number>()
  candidates.forEach((c, i) => {
    const a = res.answers[`rel_${i}`]
    relevance.set(c.section.id, a && a.kind === "noul" ? a.noul : 0)
  })

  const hybrid = candidates.map((c) => {
    const rel = relevance.get(c.section.id) ?? 0
    const lex = c.score / maxLex
    return { section: c.section, combined: 0.75 * rel + 0.25 * lex, rel, lex }
  })
  hybrid.sort((a, b) => b.combined - a.combined)
  return {
    ranked: hybrid.slice(0, topK).filter((h) => h.rel > 0.25).map((h) => h.section),
    relevance,
    usedJev: true,
  }
}
