import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../config.js"
import { expandPath } from "../config.js"
import type { DiffFile, DiffHunk, RepoDiff } from "../types.js"

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

export function git(repoDir: string, args: string[], timeoutMs = 30_000): GitResult {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  if (res.error) return { code: null, stdout: "", stderr: String(res.error) }
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  const lines = text.split("\n")
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let newLine = 0
  let oldLine = 0

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header) {
      file = {
        path: header[2]!,
        ...(header[1] !== header[2] ? { oldPath: header[1] } : {}),
        binary: false,
        hunks: [],
      }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      file.binary = true
      continue
    }
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("rename from") || line.startsWith("rename to") || line.startsWith("similarity index") || line.startsWith("old mode") || line.startsWith("new mode")) {
      continue
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      oldLine = Number(hunkMatch[1])
      newLine = Number(hunkMatch[2])
      continue
    }
    if (!hunk) continue
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newLine })
      newLine++
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldLine })
      oldLine++
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), newLine, oldLine })
      newLine++
      oldLine++
    }
  }
  return files
}

export function addedLines(file: DiffFile): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "add" && l.newLine !== undefined) out.push({ text: l.text, line: l.newLine })
    }
  }
  return out
}

export function repoDirs(config: Config, root: string): { repo: string; dir: string }[] {
  const superPath = expandPath(config.repos.super, root)
  const dirs = [{ repo: "(super)", dir: superPath }]
  for (const member of config.repos.members) {
    const dir = join(superPath, member)
    if (existsSync(join(dir, ".git"))) dirs.push({ repo: member, dir })
  }
  return dirs
}

function dirtyFiles(repoDir: string): { modified: string[]; untracked: string[] } {
  const modified: string[] = []
  const untracked: string[] = []
  const res = git(repoDir, ["status", "--porcelain=v1"])
  if (res.code !== 0) return { modified, untracked }
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    const path = line.slice(3).trim().replace(/"(.*)"/, "$1")
    if (!path) continue
    if (xy.includes("?")) untracked.push(path)
    else modified.push(path)
  }
  if (untracked.length > 0) {
    // porcelain collapses fully-untracked directories to "dir/"; expand to the
    // exact file list (still .gitignore-aware) so nothing hides from the gates.
    const ls = git(repoDir, ["ls-files", "--others", "--exclude-standard"])
    const dirs = untracked.filter((p) => p.endsWith("/"))
    if (ls.code === 0 && dirs.length > 0) {
      const exact = ls.stdout.split("\n").filter(Boolean)
      const expanded = new Set<string>()
      for (const p of untracked) {
        if (!p.endsWith("/")) {
          expanded.add(p)
          continue
        }
        const prefix = p.slice(0, -1)
        for (const f of exact) {
          if (f === prefix || f.startsWith(prefix + "/")) expanded.add(f)
        }
      }
      untracked.length = 0
      untracked.push(...expanded)
    }
  }
  return { modified, untracked }
}

export function dirtySet(config: Config, root: string): RepoDiff[] {
  const out: RepoDiff[] = []
  for (const { repo, dir } of repoDirs(config, root)) {
    const { modified, untracked } = dirtyFiles(dir)
    const files: DiffFile[] = []
    const seen = new Set<string>()
    for (const path of [...modified, ...untracked]) {
      if (seen.has(path)) continue
      seen.add(path)
      if (untracked.includes(path)) {
        try {
          const content = readFileSync(join(dir, path), "utf8")
          const lines = content.split("\n")
          files.push({
            path,
            binary: false,
            hunks: [{ header: "@@ new file @@", lines: lines.map((text, i) => ({ kind: "add" as const, text, newLine: i + 1 })) }],
          })
        } catch {
          files.push({ path, binary: true, hunks: [] })
        }
        continue
      }
      const combined = git(dir, ["diff", "HEAD", "--", path]).stdout + git(dir, ["diff", "--cached", "--", path]).stdout
      const parsed = parseUnifiedDiff(combined)
      files.push(...parsed)
    }
    if (files.length > 0) out.push({ repo, repoDir: dir, files })
  }
  return out
}

export function commitDiff(repoDir: string, sha: string): DiffFile[] {
  const res = git(repoDir, ["show", "--format=", "--diff-filter=AM", sha])
  if (res.code !== 0) return []
  return parseUnifiedDiff(res.stdout)
}

export function recentCommits(repoDir: string, count = 10, branch = "main"): { sha: string; subject: string }[] {
  const res = git(repoDir, ["log", "--oneline", `-${count}`, branch])
  if (res.code !== 0) return []
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sha = line.slice(0, 40).split(" ")[0] ?? ""
      const subject = line.slice(sha.length).trim()
      return { sha, subject }
    })
}
