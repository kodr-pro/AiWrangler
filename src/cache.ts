import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "./config.js"
import { expandPath } from "./config.js"
import { sha256Hex } from "./hash.js"
import type { JevResult } from "./jev/client.js"

export interface CacheKeyInput {
  state: unknown
  questions: Record<string, unknown>
  model: string
}

export function cacheKey(input: CacheKeyInput): string {
  return sha256Hex(
    JSON.stringify({
      state: input.state,
      questions: Object.keys(input.questions).sort().map((k) => [k, input.questions[k]]),
      model: input.model,
    }),
  )
}

export class VerdictCache {
  private dir: string | null = null

  constructor(config: Config, root: string, enabled = true) {
    if (!enabled) return
    this.dir = join(expandPath(config.cache.dir, root), "cache")
  }

  pathFor(key: string): string {
    return join(this.dir ?? "/tmp", `${key}.json`)
  }

  get(key: string): JevResult | null {
    if (!this.dir) return null
    const p = this.pathFor(key)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, "utf8")) as JevResult
    } catch {
      return null
    }
  }

  put(key: string, result: JevResult): void {
    if (!this.dir) return
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.pathFor(key), JSON.stringify(result), "utf8")
  }
}
