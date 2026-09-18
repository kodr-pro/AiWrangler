import { EventEmitter } from "node:events"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { LedgerEntry } from "../ledger.js"

export interface WatchTargets {
  ledgerPath: string
  loopStatePath: string
  cacheDir: string
  overridesPath: string
  diffsDir: string
}

export type WebuiEvent =
  | { type: "ledger"; entries: LedgerEntry[] }
  | { type: "change"; what: "loop" | "cache" | "overrides" | "diffs" }

export class Watcher extends EventEmitter {
  private targets: WatchTargets
  private timer: NodeJS.Timeout | null = null
  private ledgerSize = 0
  private signatures = new Map<string, string>()

  constructor(targets: WatchTargets) {
    super()
    this.targets = targets
    this.baseline()
  }

  private baseline(): void {
    this.ledgerSize = this.sizeOf(this.targets.ledgerPath)
    this.signatures.set("loop", this.mtimeOf(this.targets.loopStatePath))
    this.signatures.set("cache", this.dirSignature(this.targets.cacheDir))
    this.signatures.set("diffs", this.dirSignature(this.targets.diffsDir))
    this.signatures.set("overrides", this.mtimeOf(this.targets.overridesPath) + ":" + (existsSync(this.targets.overridesPath) ? "1" : "0"))
  }

  start(intervalMs = 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    const size = this.sizeOf(this.targets.ledgerPath)
    if (size > this.ledgerSize) {
      const entries = this.readNewLedgerLines()
      this.ledgerSize = size
      if (entries.length > 0) this.emit("event", { type: "ledger", entries } satisfies WebuiEvent)
    } else if (size < this.ledgerSize) {
      this.ledgerSize = size
    }

    const check = (key: "loop" | "cache" | "overrides" | "diffs", sig: string) => {
      const prev = this.signatures.get(key)
      if (prev !== sig) {
        this.signatures.set(key, sig)
        this.emit("event", { type: "change", what: key } satisfies WebuiEvent)
      }
    }
    check("loop", this.mtimeOf(this.targets.loopStatePath))
    check("cache", this.dirSignature(this.targets.cacheDir))
    check("diffs", this.dirSignature(this.targets.diffsDir))
    check("overrides", this.mtimeOf(this.targets.overridesPath) + ":" + (existsSync(this.targets.overridesPath) ? "1" : "0"))
  }

  private readNewLedgerLines(): LedgerEntry[] {
    try {
      const text = readFileSync(this.targets.ledgerPath, "utf8")
      const previous = this.ledgerSize
      const slice = text.slice(previous)
      return slice
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
    } catch {
      return []
    }
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  private mtimeOf(path: string): string {
    try {
      return String(statSync(path).mtimeMs)
    } catch {
      return "0"
    }
  }

  private dirSignature(dir: string): string {
    try {
      return readdirSync(dir).sort().join("|")
    } catch {
      return ""
    }
  }
}

export function watcherPaths(cacheDir: string, ledgerPath: string): WatchTargets {
  return {
    ledgerPath,
    loopStatePath: join(cacheDir, "loop-state.json"),
    cacheDir,
    overridesPath: join(cacheDir, "runtime-overrides.json"),
    diffsDir: join(cacheDir, "diffs"),
  }
}
