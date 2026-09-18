import type { Corpus, CorpusSection, SourceKind } from "../types.js"

const STOPWORDS = new Set(
  "the a an and or but for with without that this these those from into onto when where which while must should shall will would could can may might not no yes it its their there here of to in on at by as is are be been was were do does did done have has had also new add change make implement use using per each every some any all how what why who".split(
    " ",
  ),
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

export interface LexicalIndex {
  sections: CorpusSection[]
  df: Map<string, number>
}

export function buildIndex(corpus: Corpus, kinds?: SourceKind[]): LexicalIndex {
  const sections = kinds ? corpus.sections.filter((s) => kinds.includes(s.kind)) : corpus.sections
  const df = new Map<string, number>()
  for (const s of sections) {
    for (const term of new Set(tokenize(s.title + " " + s.text))) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { sections, df }
}

export interface Scored {
  section: CorpusSection
  score: number
}

export function lexicalScore(index: LexicalIndex, query: string): Scored[] {
  const qTerms = tokenize(query)
  const N = Math.max(index.sections.length, 1)
  const scores: Scored[] = []
  for (const section of index.sections) {
    const titleTerms = new Set(tokenize(section.title))
    const bodyTerms = tokenize(section.text)
    const tf = new Map<string, number>()
    for (const t of bodyTerms) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const term of new Set(qTerms)) {
      const dfCount = index.df.get(term) ?? 0
      if (dfCount === 0) continue
      const idf = Math.log(1 + N / dfCount)
      const tfCount = tf.get(term) ?? 0
      if (tfCount > 0) score += idf * (1 + Math.log(tfCount)) / (1 + Math.log(bodyTerms.length || 1)) * 10
      if (titleTerms.has(term)) score += idf * 3
    }
    if (section.kind === "door") score += 0.5
    scores.push({ section, score })
  }
  return scores.sort((a, b) => b.score - a.score)
}

export function shortlist(index: LexicalIndex, query: string, k: number): Scored[] {
  return lexicalScore(index, query).filter((s) => s.score > 0).slice(0, k)
}

export function excerpt(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars) + "..."
}
