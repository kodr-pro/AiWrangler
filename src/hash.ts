import { createHash } from "node:crypto"

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function shortHash(text: string): string {
  return sha256Hex(text).slice(0, 12)
}
