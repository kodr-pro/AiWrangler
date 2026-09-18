export type SourceKind = "spec" | "rule" | "divergence" | "question" | "door" | "paper" | "doc"

export type EntryStatus = "ruled" | "open" | "answered" | "info"

export interface CorpusSection {
  id: string
  kind: SourceKind
  title: string
  text: string
  source: string
  status: EntryStatus
  ruling?: string
  paperRef?: string
  precedence: number
}

export interface CorpusSource {
  path: string
  hash: string
}

export interface Corpus {
  sections: CorpusSection[]
  sources: CorpusSource[]
  hash: string
  paperText: string
}

export const PRECEDENCE = {
  ruling: 0,
  paper: 1,
  door: 1,
  spec: 2,
  doc: 3,
  nonRuling: 4,
} as const

export type Severity = "block" | "review" | "human"

export interface DiffLine {
  kind: "add" | "del" | "ctx"
  text: string
  newLine?: number
  oldLine?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string
  binary: boolean
  hunks: DiffHunk[]
}

export interface RepoDiff {
  repo: string
  repoDir: string
  files: DiffFile[]
}

export interface Finding {
  rule: string
  severity: Severity
  repo: string
  file: string
  line: number | null
  evidence: string
  note: string
  kind?: "deterministic" | "semantic"
  confidence?: number
  noul?: number
  acknowledged?: boolean
}
