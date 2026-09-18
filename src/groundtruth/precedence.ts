import type { Corpus, CorpusSection } from "../types.js"

export function sectionById(corpus: Corpus, id: string): CorpusSection | undefined {
  return corpus.sections.find((s) => s.id === id)
}

export function sectionsOfKind(corpus: Corpus, kind: CorpusSection["kind"]): CorpusSection[] {
  return corpus.sections.filter((s) => s.kind === kind)
}

export function effectiveTruth(corpus: Corpus): CorpusSection[] {
  return corpus.sections.filter((s) => s.precedence === 0)
}

export function paperSectionForSpec(corpus: Corpus, spec: CorpusSection): CorpusSection | undefined {
  if (!spec.paperRef) return undefined
  return corpus.sections.find((s) => s.id === `PAPER-${spec.paperRef}`)
}

export function authoritativeFor(conflicting: CorpusSection, corpus: Corpus): CorpusSection | null {
  const candidates = corpus.sections.filter(
    (s) => s.precedence < conflicting.precedence && overlaps(conflicting, s),
  )
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => a.precedence - b.precedence)[0] ?? null
}

function overlaps(a: CorpusSection, b: CorpusSection): boolean {
  const tokens = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 4),
    )
  const aw = tokens(a.title + " " + a.text.slice(0, 500))
  const bw = tokens(b.title + " " + b.text.slice(0, 500))
  if (aw.size === 0 || bw.size === 0) return false
  let shared = 0
  for (const w of bw) if (aw.has(w)) shared++
  return shared / Math.min(aw.size, bw.size) > 0.06
}
