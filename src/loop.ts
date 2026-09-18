import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { sha256Hex } from "./hash.js"

export interface LoopCycle {
  ts: string
  diffHash: string
  action: string
  topReasons: string[]
}

export interface LoopState {
  cycles: LoopCycle[]
}

export interface LoopVerdict {
  cycle: number
  repeatedDiff: boolean
  escalate: boolean
  reason?: string
}

export function diffFingerprint(diffText: string): string {
  return sha256Hex(diffText)
}

export class LoopTracker {
  private path: string
  private state: LoopState

  constructor(statePath: string) {
    this.path = statePath
    this.state = { cycles: [] }
    if (existsSync(statePath)) {
      try {
        this.state = JSON.parse(readFileSync(statePath, "utf8")) as LoopState
      } catch {
        this.state = { cycles: [] }
      }
    }
  }

  get history(): LoopCycle[] {
    return this.state.cycles
  }

  record(cycle: LoopCycle): void {
    this.state.cycles = [...this.state.cycles.slice(-9), cycle]
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.state), "utf8")
  }

  reset(): void {
    this.state = { cycles: [] }
    if (existsSync(this.path)) mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.state), "utf8")
  }

  evaluate(diffHash: string, reasons: string[], maxCycles: number): LoopVerdict {
    const last = this.state.cycles[this.state.cycles.length - 1]
    if (!last) return { cycle: 1, repeatedDiff: false, escalate: false }

    const repeatedDiff = last.diffHash === diffHash
    const reasonsOverlap =
      reasons.filter((r) => last.topReasons.some((prev) => overlapTokens(prev, r) > 0.5)).length >=
      Math.min(2, reasons.length)

    const cycle = repeatedDiff || reasonsOverlap ? this.consecutiveCount(diffHash, reasons) + 1 : 1
    if (cycle >= maxCycles) {
      return {
        cycle,
        repeatedDiff,
        escalate: true,
        reason: `circuit breaker: ${cycle} consecutive wrangler cycles without progress (repeated diff: ${repeatedDiff}, same findings: ${reasonsOverlap}); stop retrying and surface to the user`,
      }
    }
    return { cycle, repeatedDiff, escalate: false }
  }

  private consecutiveCount(diffHash: string, reasons: string[]): number {
    let n = 0
    for (let i = this.state.cycles.length - 1; i >= 0; i--) {
      const c = this.state.cycles[i]!
      if (c.diffHash === diffHash || reasonsOverlap(c.topReasons, reasons)) n++
      else break
    }
    return n
  }
}

function overlapTokens(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3))
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of tb) if (ta.has(t)) shared++
  return shared / Math.max(ta.size, tb.size)
}

function reasonsOverlap(a: string[], b: string[]): boolean {
  return b.some((r) => a.some((prev) => overlapTokens(prev, r) > 0.5))
}
