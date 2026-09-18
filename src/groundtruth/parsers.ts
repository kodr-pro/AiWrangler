import type { CorpusSection, EntryStatus, SourceKind } from "../types.js"
import { PRECEDENCE } from "../types.js"
import { splitMarkdown, slug } from "./sectionize.js"

function section(partial: Omit<CorpusSection, "precedence"> & { precedence?: number }): CorpusSection {
  return { precedence: PRECEDENCE.doc, ...partial }
}

const ROMAN_RE = /^[IVX]+(?:-[A-Z])?$/

export function parseSpec(md: string, source: string): CorpusSection[] {
  const out: CorpusSection[] = []
  for (const sec of splitMarkdown(md)) {
    const m = sec.title.match(/^(\d+)\.\s+(.*)$/)
    if (!m) continue
    const title = m[2]!
    const ref = title.match(/\(([^)]+)\)\s*$/)
    const paperRef = ref && ROMAN_RE.test(ref[1]!) ? ref[1] : undefined
    out.push(
      section({
        id: `SPEC-${m[1]}`,
        kind: "spec",
        title,
        text: sec.text,
        source,
        status: "info",
        ...(paperRef ? { paperRef } : {}),
        precedence: PRECEDENCE.spec,
      }),
    )
  }
  return out
}

export function parseRules(md: string, source: string): CorpusSection[] {
  const lines = md.split("\n")
  const out: CorpusSection[] = []
  let current: { n: string; lines: string[] } | null = null
  const flush = () => {
    if (!current) return
    out.push(
      section({
        id: `RULE-${current.n}`,
        kind: "rule",
        title: current.lines[0]!.trim(),
        text: current.lines.join("\n").trim(),
        source,
        status: "info",
        precedence: PRECEDENCE.spec,
      }),
    )
    current = null
  }
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.*)$/)
    if (m) {
      flush()
      current = { n: m[1]!, lines: [m[2]!] }
      continue
    }
    if (current && (/^\s{2,}/.test(line) || line.trim() === "")) {
      if (line.trim() === "" && current.lines[current.lines.length - 1] === "") continue
      current.lines.push(line.trim() === "" ? "" : line.trim())
      continue
    }
    flush()
  }
  flush()
  return out
}

export function parseDivergences(md: string, source: string): CorpusSection[] {
  const lines = md.split("\n")
  const out: CorpusSection[] = []
  let topic = ""
  let current: { id: string; lines: string[]; topic: string } | null = null
  const flush = () => {
    if (!current) return
    const body = current.lines.join("\n").trim()
    const marker = body.indexOf("**RULED")
    const ruled = marker >= 0
    const ruling = ruled
      ? body
          .slice(marker)
          .replace(/\*\*/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 800)
      : undefined
    out.push(
      section({
        id: `DIV-D-${current.id}`,
        kind: "divergence",
        title: `${current.topic ? current.topic + ": " : ""}${current.lines[0]!.trim()}`,
        text: body,
        source,
        status: ruled ? "ruled" : "open",
        ...(ruled && ruling ? { ruling } : {}),
        precedence: ruled ? PRECEDENCE.ruling : PRECEDENCE.nonRuling,
      }),
    )
    current = null
  }
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) {
      flush()
      topic = h[1]!.trim()
      continue
    }
    const m = line.match(/^D-(\d+)\s+(.*)$/)
    if (m) {
      flush()
      current = { id: m[1]!, lines: [m[2]!], topic }
      continue
    }
    if (current) current.lines.push(line)
  }
  flush()
  return out
}

export function parseQuestions(md: string, source: string): CorpusSection[] {
  const lines = md.split("\n")
  const out: CorpusSection[] = []
  let heading = ""
  let current: { n: string; lines: string[]; heading: string } | null = null
  const flush = () => {
    if (!current) return
    const body = current.lines.join("\n").trim()
    const marker = body.indexOf("**ANSWERED")
    const answered = marker >= 0
    const ruling = answered
      ? body
          .slice(marker)
          .replace(/\*\*/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 800)
      : undefined
    out.push(
      section({
        id: `Q-${current.n}`,
        kind: "question",
        title: current.lines[0]!.trim(),
        text: body,
        source,
        status: answered ? "answered" : "open",
        ...(answered && ruling ? { ruling } : {}),
        precedence: answered ? PRECEDENCE.ruling : PRECEDENCE.nonRuling,
      }),
    )
    current = null
  }
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/)
    if (h) {
      flush()
      heading = h[1]!.trim()
      continue
    }
    const m = line.match(/^(\d+)\.\s+(.*)$/)
    if (m) {
      flush()
      current = { n: m[1]!, lines: [m[2]!], heading }
      continue
    }
    if (current) current.lines.push(line)
  }
  flush()
  return out
}

export function parsePlan(md: string, source: string): CorpusSection[] {
  const out: CorpusSection[] = []
  for (const sec of splitMarkdown(md)) {
    if (!/one-way door|launch gate/i.test(sec.title)) continue
    out.push(
      section({
        id: `DOOR-${slug(sec.title) || out.length + 1}`,
        kind: "door",
        title: sec.title,
        text: sec.text,
        source,
        status: "info",
        precedence: PRECEDENCE.door,
      }),
    )
  }
  return out
}

export function parseDoc(md: string, source: string, label: string): CorpusSection[] {
  return splitMarkdown(md)
    .filter((s) => s.text.length > 0)
    .map((sec, i) =>
      section({
        id: `DOC-${label}-${String(i + 1).padStart(2, "0")}`,
        kind: "doc" as SourceKind,
        title: sec.title || "(intro)",
        text: sec.text,
        source,
        status: "info" as EntryStatus,
        precedence: PRECEDENCE.doc,
      }),
    )
}

const PAPER_HEADING_RE = /^([IVX]+(?:-[A-Z])?)?\.?\s{1,4}(.+)$/
const ROMAN_ONLY_RE = /^[IVX]+$/

function mergeSpacedCaps(title: string): string {
  const tokens = title.split(/\s+/).filter(Boolean)
  const merged: string[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    const next = tokens[i + 1]
    if (next !== undefined && /^-?[A-Z]$/.test(tok) && /^[A-Z]/.test(next) && next.length > 1) {
      merged.push((tok.startsWith("-") ? tok : "") + next)
      i += 2
      continue
    }
    if (tok.length === 1 && /^[A-Z]$/.test(tok) && next !== undefined && /^[A-Z]/.test(next)) {
      merged.push(tok + next)
      i += 2
      continue
    }
    merged.push(tok)
    i++
  }
  return merged.join(" ").replace(/ -/g, "-").replace(/\s+,/g, ",")
}

function capsRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z]/g, "")
  if (letters.length === 0) return 0
  const upper = letters.replace(/[^A-Z]/g, "")
  return upper.length / letters.length
}

export function parsePaper(text: string, source: string): CorpusSection[] {
  const lines = text.split("\n").map((l) => l.replace(/^\f/, ""))
  const byId = new Map<string, CorpusSection>()
  let current: { id: string; title: string; lines: string[] } | null = null

  const looksLikeCapsFragment = (line: string): boolean => {
    const t = line.trim()
    return t.length >= 3 && t.length <= 40 && !/[.:;]$/.test(t) && !/\.\s*\.\s*\./.test(t) && capsRatio(t) >= 0.6
  }

  const flush = () => {
    if (!current) return
    const body = current.lines.join("\n").trim()
    const existing = byId.get(current.id)
    if (existing) {
      existing.text = (existing.text + "\n" + body).trim()
    } else {
      byId.set(
        current.id,
        section({
          id: `PAPER-${current.id}`,
          kind: "paper",
          title: current.title,
          text: body,
          source,
          status: "info",
          precedence: PRECEDENCE.paper,
        }),
      )
    }
    current = null
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? ""
    if (/\.\s*\.\s*\./.test(line)) continue
    const m = line.match(PAPER_HEADING_RE)
    if (m && m[1] && !ROMAN_ONLY_RE.test(m[2] ?? "") && !/^[ivx]+$/.test(m[1])) {
      let title = mergeSpacedCaps(m[2] ?? "")
      let consumed = 1
      while (
        li + consumed < lines.length &&
        looksLikeCapsFragment(lines[li + consumed] ?? "") &&
        title.split(/\s+/).length < 10
      ) {
        title = title + " " + mergeSpacedCaps((lines[li + consumed] ?? "").trim())
        consumed++
      }
      const letters = title.replace(/[^A-Za-z]/g, "")
      if (letters.length >= 4 && capsRatio(title) >= 0.7) {
        flush()
        current = { id: m[1], title: title.replace(/\s{2,}/g, " ").trim(), lines: [] }
        li += consumed - 1
        continue
      }
    }
    if (current) current.lines.push(line)
  }
  flush()
  return [...byId.values()]
}
