import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export function ensureToken(stateDir: string): string {
  const path = join(stateDir, "webui-token")
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim()
    if (existing.length >= 32) return existing
  }
  const token = randomBytes(32).toString("hex")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* chmod is best effort on some filesystems */
  }
  return token
}

export function verifyToken(provided: string | null | undefined, token: string): boolean {
  if (!provided || !token) return false
  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(token, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function tokenFromRequest(url: URL, authorization: string | undefined): string | null {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim()
  const q = url.searchParams.get("token")
  if (q) return q.trim()
  return null
}
