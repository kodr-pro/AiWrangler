import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Config } from "./config.js"
import { expandPath } from "./config.js"

export interface GateLedgerEntry {
  ts: string
  kind: "plan" | "check"
  model: string
  corpusHash: string
  action: string
  usage?: { inputTokens: number; outputTokens: number }
  findings: { rule: string; severity: string; subject: string; acknowledged?: boolean }[]
  verdicts?: { question: string; noul: number }[]
  reasons?: string[]
  sessionID?: string
  diffHash?: string
  files?: { repo: string; path: string; added: number; removed: number }[]
  examinedFiles?: number | null
  overridesActive?: boolean
}

export interface NoticeLedgerEntry {
  ts: string
  kind: "notice"
  message: string
}

export interface OverrideLedgerEntry {
  ts: string
  kind: "override"
  source: string
  changes: Record<string, unknown>
  note?: string
}

export interface AckLedgerEntry {
  ts: string
  kind: "ack"
  diffHash: string
  rules: string[]
  note?: string
  by?: string
}

export type LedgerEntry = GateLedgerEntry | NoticeLedgerEntry | OverrideLedgerEntry | AckLedgerEntry

export type LedgerKind = LedgerEntry["kind"]

export class Ledger {
  private path: string

  constructor(config: Config, root: string) {
    this.path = expandPath(config.ledger.path, root)
  }

  get filePath(): string {
    return this.path
  }

  append(entry: LedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
  }

  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LedgerEntry
        } catch {
          return null
        }
      })
      .filter((e): e is LedgerEntry => e !== null)
  }

  recent(kind?: LedgerKind, n = 20): LedgerEntry[] {
    return this.read()
      .filter((e) => (kind ? e.kind === kind : true))
      .slice(-n)
  }

  acksFor(diffHash: string): AckLedgerEntry[] {
    return this.read().filter((e): e is AckLedgerEntry => e.kind === "ack" && e.diffHash === diffHash)
  }

  latestAckFor(diffHash: string): AckLedgerEntry | null {
    const acks = this.acksFor(diffHash)
    return acks.length > 0 ? acks[acks.length - 1]! : null
  }
}
