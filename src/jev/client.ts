import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { Config } from "../config.js"
import { cacheKey, VerdictCache } from "../cache.js"

export type JevValue =
  | { kind: "noul"; noul: number }
  | { kind: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: "score"; score: number; confidence: number; probabilities: Record<string, number> }

export interface JevResult {
  model: string
  usage: { inputTokens: number; outputTokens: number }
  answers: Record<string, JevValue>
  cached?: boolean
}

export interface JevUnavailable {
  ok: false
  reason: "egress-off" | "no-key"
}

let warned = false
let warnSink: ((message: string) => void) | null = null

export function setJevWarnSink(sink: ((message: string) => void) | null): void {
  warnSink = sink
}

export function jevWarnMessage(model: string): string {
  return (
    "aiwrangler: semantic gate sends task/diff/spec text to api.typesafe.ai (model " +
    model +
    "). Set AIWRANGLER_EGRESS=off to disable."
  )
}

function emitWarning(model: string): void {
  if (warned) return
  warned = true
  const message = jevWarnMessage(model)
  if (process.env.AIWRANGLER_STDERR === "1") process.stderr.write(message + "\n")
  warnSink?.(message)
}

export class Jev {
  private client: TypeSafeClient | null = null
  readonly model: string
  private readonly semantic: boolean
  private readonly warnOnce: boolean
  private readonly keyPresent: boolean
  private readonly cache: VerdictCache | null

  constructor(config: Config, opts: { cacheDir?: string; cacheEnabled?: boolean } = {}) {
    this.model = config.model
    this.semantic = config.egress.semantic
    this.warnOnce = config.egress.warnOncePerSession
    this.keyPresent = Boolean(process.env.TYPESAFE_API_KEY)
    this.cache =
      opts.cacheDir !== undefined ? new VerdictCache(config, opts.cacheDir, opts.cacheEnabled ?? true) : null
  }

  unavailable(): JevUnavailable | null {
    if (!this.semantic) return { ok: false, reason: "egress-off" }
    if (!this.keyPresent) return { ok: false, reason: "no-key" }
    return null
  }

  private ensure(): TypeSafeClient | null {
    const blocked = this.unavailable()
    if (blocked) return null
    if (!this.client) {
      this.client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY!, defaultModel: this.model })
      if (this.warnOnce) emitWarning(this.model)
    }
    return this.client
  }

  async ask(
    state: unknown,
    questions: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<JevResult> {
    if (this.cache) {
      const key = cacheKey({ state, questions, model: this.model })
      const hit = this.cache.get(key)
      if (hit) return { ...hit, cached: true }
    }
    const client = this.ensure()
    if (!client) throw new Error("jev unavailable: " + (this.unavailable()?.reason ?? "unknown"))
    const res = await client.systemOne(
      {
        state: state as never,
        questions: questions as never,
        model: this.model,
      },
      {
        timeout: opts.timeoutMs ?? 60_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    )
    const answers: Record<string, JevValue> = {}
    for (const [key, raw] of Object.entries(res.answers as Record<string, any>)) {
      if (raw?.type === "noul") answers[key] = { kind: "noul", noul: Number(raw.noul) }
      else if (raw?.type === "choice")
        answers[key] = {
          kind: "choice",
          choice: String(raw.choice),
          confidence: Number(raw.confidence),
          probabilities: raw.probabilities as Record<string, number>,
        }
      else if (raw?.type === "score")
        answers[key] = {
          kind: "score",
          score: Number(raw.score),
          confidence: Number(raw.confidence),
          probabilities: raw.probabilities as Record<string, number>,
        }
    }
    const result: JevResult = {
      model: res.model,
      usage: { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 },
      answers,
    }
    if (this.cache) {
      const key = cacheKey({ state, questions, model: this.model })
      this.cache.put(key, result)
    }
    return result
  }
}
