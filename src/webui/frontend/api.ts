export function getToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token")
  if (fromUrl) {
    localStorage.setItem("aiwrangler_token", fromUrl)
    history.replaceState(null, "", location.pathname)
    return fromUrl
  }
  return localStorage.getItem("aiwrangler_token") ?? ""
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${getToken()}`,
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

export async function apiText(path: string): Promise<string> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`)
  return res.text()
}

export interface LedgerFinding {
  rule: string
  severity: string
  subject: string
  acknowledged?: boolean
}

export interface GateEntry {
  ts: string
  kind: "plan" | "check" | "notice" | "override" | "ack"
  model?: string
  corpusHash?: string
  action?: string
  usage?: { inputTokens: number; outputTokens: number }
  findings?: LedgerFinding[]
  verdicts?: { question: string; noul: number }[]
  reasons?: string[]
  sessionID?: string
  diffHash?: string
  files?: { repo: string; path: string; added: number; removed: number }[]
  examinedFiles?: number | null
  overridesActive?: boolean
  message?: string
  changes?: Record<string, unknown>
  diffHashAck?: string
  rules?: string[]
  note?: string
  by?: string
}

export interface StatusResponse {
  ok: boolean
  serverTime: string
  config: {
    model: string
    activePolicy: string
    policies: string[]
    thresholds: { actionThreshold: number; reviewThreshold: number }
    egressSemantic: boolean
    source: string
    path: string | null
    overridesActive: boolean
    overrides: { createdAt: string; note?: string; expiresOn: string; overrides: Record<string, unknown> } | null
  }
  gates: { gate: string; on: boolean }[]
  corpus: { hash: string; counts: { kind: string; n: number }[]; sources: { path: string; hash: string }[] }
  loop: { cycles?: { ts: string; diffHash: string; action: string; topReasons: string[] }[]; maxCycles?: number }
  dirty: { repo: string; path: string }[]
}

export interface CacheListResponse {
  ok: boolean
  entries: { key: string; model: string; usage: { inputTokens: number; outputTokens: number }; questions: string[] }[]
}

export interface CacheEntryResponse {
  ok: boolean
  entry: {
    model: string
    usage: { inputTokens: number; outputTokens: number }
    answers: Record<string, AnswerValue>
  }
}

export type AnswerValue =
  | { kind: "noul"; noul: number }
  | { kind: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: "score"; score: number; confidence: number; probabilities: Record<string, number> }

export interface CorpusResponse {
  ok: boolean
  hash: string
  sources: { path: string; hash: string }[]
  sections: { id: string; kind: string; title: string; status: string; precedence: number; ruling?: string; text: string }[]
}

export interface LoopResponse {
  ok: boolean
  loop: { cycles?: { ts: string; diffHash: string; action: string; topReasons: string[] }[] }
  acks: { ts: string; diffHash: string; rules: string[]; note?: string; by?: string }[]
}
