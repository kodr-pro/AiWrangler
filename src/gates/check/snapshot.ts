import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../../config.js"
import { expandPath } from "../../config.js"
import type { RepoDiff } from "../../types.js"

const SNAPSHOT_CAP = 200_000
const KEEP_SNAPSHOTS = 20

export function snapshotsDir(config: Config, root: string): string {
  return join(expandPath(config.cache.dir, root), "diffs")
}

export function renderDiffSnapshot(diffs: RepoDiff[]): string {
  const out: string[] = [`snapshot generated ${new Date().toISOString()}; added lines carry their new-file line number`]
  for (const d of diffs) {
    for (const f of d.files) {
      if (f.binary) {
        out.push(`## ${d.repo} ${f.path} (binary)`)
        continue
      }
      let added = 0
      let removed = 0
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.kind === "add") added++
          else if (l.kind === "del") removed++
        }
      }
      out.push(`## ${d.repo} ${f.path} (+${added}/-${removed})`)
      for (const h of f.hunks) {
        out.push(h.header)
        for (const l of h.lines) {
          if (l.kind === "add") out.push(`+${l.newLine ?? "?"}| ${l.text}`)
          else if (l.kind === "del") out.push(`-| ${l.text}`)
        }
      }
    }
  }
  let text = out.join("\n")
  if (text.length > SNAPSHOT_CAP) {
    text = text.slice(0, SNAPSHOT_CAP) + `\n... [snapshot truncated at ${SNAPSHOT_CAP} chars]`
  }
  return text
}

export function writeDiffSnapshot(config: Config, root: string, diffHash: string, diffs: RepoDiff[]): string | null {
  if (diffs.length === 0) return null
  const dir = snapshotsDir(config, root)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${diffHash}.txt`)
  const tmp = path + ".tmp"
  writeFileSync(tmp, renderDiffSnapshot(diffs) + "\n", "utf8")
  renameSync(tmp, path)
  pruneSnapshots(dir)
  return path
}

function pruneSnapshots(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith(".txt"))
  } catch {
    return
  }
  if (entries.length <= KEEP_SNAPSHOTS) return
  const withTimes = entries
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((e): e is { name: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime)
  for (const old of withTimes.slice(KEEP_SNAPSHOTS)) {
    try {
      unlinkSync(join(dir, old.name))
    } catch {
      /* best effort */
    }
  }
}

export function readDiffSnapshot(config: Config, root: string, diffHash: string): string | null {
  if (!/^[0-9a-f]{16,64}$/.test(diffHash)) return null
  const path = join(snapshotsDir(config, root), `${diffHash}.txt`)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
