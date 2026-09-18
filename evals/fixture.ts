import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const fixtureConfigPath = fileURLToPath(new URL("./corpus/aiwrangler.config.json", import.meta.url))
export const fixtureCorpusDir = fileURLToPath(new URL("./corpus", import.meta.url))

export function fixtureEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, AIWRANGLER_CONFIG: fixtureConfigPath, ...extra }
}

export function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "aw-cache-"))
}
