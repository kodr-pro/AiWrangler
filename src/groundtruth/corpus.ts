import { readFileSync } from "node:fs"
import type { Config, LoadedConfig } from "../config.js"
import { expandPath, loadConfig } from "../config.js"
import { sha256Hex } from "../hash.js"
import type { Corpus, CorpusSection, CorpusSource } from "../types.js"
import { parseDivergences, parseDoc, parsePaper, parsePlan, parseQuestions, parseRules, parseSpec } from "./parsers.js"
import { ensurePaperText } from "./whitepaper.js"

function slugFromPath(rel: string): string {
  return rel
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

function readOr(path: string, fallback: CorpusSection[]): { text: string | null; sections: CorpusSection[] } {
  try {
    return { text: readFileSync(path, "utf8"), sections: [] }
  } catch {
    return { text: null, sections: fallback }
  }
}

export function loadCorpus(config: Config, root: string): Corpus {
  const sections: CorpusSection[] = []
  const sources: CorpusSource[] = []

  const addFile = (path: string, parse: (md: string, source: string) => CorpusSection[]) => {
    const resolved = expandPath(path, root)
    const { text } = readOr(resolved, [])
    if (text === null) return
    sources.push({ path: resolved, hash: sha256Hex(text) })
    sections.push(...parse(text, resolved))
  }

  addFile(config.corpus.spec, parseSpec)
  addFile(config.corpus.rules, parseRules)
  addFile(config.corpus.divergences, parseDivergences)
  addFile(config.corpus.questions, parseQuestions)
  addFile(config.corpus.plan, parsePlan)
  for (const doc of config.corpus.docs) {
    const resolved = expandPath(doc, root)
    let label = doc.split("/").pop()?.replace(/\.[a-z]+$/i, "") ?? "doc"
    const rel = resolved.startsWith(root + "/") ? resolved.slice(root.length + 1) : null
    if (rel && rel.includes("/")) label = slugFromPath(rel)
    addFile(doc, (md, source) => parseDoc(md, source, label))
  }

  const paper = ensurePaperText(config, root)
  if (paper.text !== null) {
    const paperPath = expandPath(config.corpus.whitepaper, root)
    sources.push({ path: paperPath, hash: sha256Hex(paper.text) })
    sections.push(...parsePaper(paper.text, paperPath))
  }

  const hash = sha256Hex(JSON.stringify({ sources: sources.map((s) => [s.path, s.hash]).sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")), ids: sections.map((s) => s.id).sort() }))
  return { sections, sources, hash, paperText: paper.text ?? "" }
}

export function loadCorpusFrom(startDir: string): { loaded: LoadedConfig; corpus: Corpus } {
  const loaded = loadConfig(startDir)
  const corpus = loadCorpus(loaded.config, loaded.root)
  return { loaded, corpus }
}
