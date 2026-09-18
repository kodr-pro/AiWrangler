import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../config.js"
import { expandPath } from "../config.js"

export function ensurePaperText(config: Config, root: string): { text: string | null; extracted: boolean } {
  const pdf = expandPath(config.corpus.whitepaper, root)
  const cacheDir = expandPath(config.cache.dir, root)
  const cached = join(cacheDir, "whitepaper.txt")
  const pdfMtime = existsSync(pdf) ? statSync(pdf).mtimeMs : 0
  if (existsSync(cached) && statSync(cached).mtimeMs >= pdfMtime) {
    return { text: readFileSync(cached, "utf8"), extracted: false }
  }
  if (!existsSync(pdf)) return { text: null, extracted: false }
  const res = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : `pdftotext exit ${res.status}`
    throw new Error(`whitepaper extraction failed (${reason}); is poppler-utils installed?`)
  }
  const text = res.stdout
  if (text.split(/\s+/).length < 1000) throw new Error("whitepaper extraction produced suspiciously little text; refusing to cache")
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cached, text, "utf8")
  return { text, extracted: true }
}
