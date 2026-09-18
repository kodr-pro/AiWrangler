import type { Config } from "../../config.js"
import type { DiffFile, Finding, RepoDiff } from "../../types.js"
import { addedLines } from "../../git/diff.js"

const SILENT_DEFAULT_PATTERNS: { re: RegExp; note: string }[] = [
  { re: /\.unwrap_or_default\(\)/, note: "unwrap_or_default() silently substitutes a default; per RULE-1 malformed/missing values must be errors" },
  { re: /\.unwrap_or\(\s*(0|false|true|None)\s*\)/, note: "unwrap_or(literal) silently substitutes a value; per RULE-1 malformed/missing values must be errors" },
  { re: /\.unwrap_or\(\s*(String::new\(\)|Vec::new\(\)|vec!\[\]|Default::default\(\))\s*\)/, note: "unwrap_or(empty container) silently substitutes; per RULE-1 malformed/missing values must be errors" },
  { re: /Ok\(\s*_\s*\)\s*=>\s*(0|false|true|None|Default::default\(\))/, note: "Ok(_) arm returns a literal default; per RULE-1 this maps a parsed value to a silent default" },
  { re: /Err\(\s*_?\s*\)\s*=>\s*(0|false|true|None|Default::default\(\)|vec!\[\])/, note: "Err(_) arm returns a literal instead of propagating; per RULE-1 errors must not become values" },
  { re: /\bcatch\s*\{\s*\}/, note: "empty catch block swallows failures; per RULE-1 unreadable/malformed input must be an error" },
]

const TODO_BARE = /TODO(?!\s*\([a-z0-9-]+\))/
const TODO_TAGGED = /TODO\([a-z0-9-]+\)/
const EM_DASH = /\u2014/
const AI_TRAILER = /^\s*(Co-Authored-By:.*\b(Claude|Copilot|GPT|ChatGPT|Gemini|Cursor)\b|Generated with)/i
const SENSITIVE_AREA = /(?<![A-Za-z])(sealed?|sealing|seals?|digests?|disclosure|keygen|keys?)(?![A-Za-z])/i
const FUEL_DECL = /((fn|const|static)\s+[A-Za-z_]*(fuel|budget|limit)[A-Za-z_]*|let\s+mut\s+[A-Za-z_]*(fuel|budget|limit)[A-Za-z_]*|:\s*(Fuel|Budget|Limit)[<\s>])/i

export function checkFile(repo: string, file: DiffFile, config: Config): Finding[] {
  const findings: Finding[] = []
  const adds = addedLines(file)
  if (adds.length === 0) return findings
  const pathSensitive = SENSITIVE_AREA.test(file.path)

  for (const { text, line } of adds) {
    for (const { re, note } of SILENT_DEFAULT_PATTERNS) {
      if (re.test(text)) {
        findings.push({ rule: "RULE-1", severity: "review", repo, file: file.path, line, evidence: text.trim().slice(0, 120), note })
      }
    }
    if (/TODO/.test(text) && TODO_BARE.test(text) && !TODO_TAGGED.test(text)) {
      findings.push({
        rule: "RULE-7",
        severity: "review",
        repo,
        file: file.path,
        line,
        evidence: text.trim().slice(0, 120),
        note: "TODO without a backend tag; every TODO must name the backend it waits on, e.g. TODO(node)",
      })
    }
    if (EM_DASH.test(text)) {
      findings.push({ rule: "RULE-6", severity: "block", repo, file: file.path, line, evidence: text.trim().slice(0, 120), note: "em dash in added line; house style bans em dashes" })
    }
    if (config.repos.members.some((m) => text.includes(`../${m}/`))) {
      findings.push({
        rule: "RULE-6",
        severity: "review",
        repo,
        file: file.path,
        line,
        evidence: text.trim().slice(0, 120),
        note: "relative path into a sibling repo; name the sibling instead of a relative path",
      })
    }
    if (FUEL_DECL.test(text)) {
      findings.push({
        rule: "RULE-9",
        severity: "review",
        repo,
        file: file.path,
        line,
        evidence: text.trim().slice(0, 120),
        note: "fuel/budget/limit declaration; must state units and who pays",
      })
    }
    if (pathSensitive || (SENSITIVE_AREA.test(text) && /^(pub\s+)?(async\s+)?(fn|struct|enum|impl|trait|mod)\s/.test(text.trim()))) {
      findings.push({
        rule: "RULE-10",
        severity: "human",
        repo,
        file: file.path,
        line,
        evidence: text.trim().slice(0, 120),
        note: "touches keys/seals/digests/disclosure; requires human eyes even if correct",
      })
    }
    if (/^\s*pub\s+(async\s+)?(fn|struct|enum|trait|type|mod|const|static)\s/.test(text) && config.repos.reviewed.includes(repo)) {
      findings.push({
        rule: "RULE-2",
        severity: "review",
        repo,
        file: file.path,
        line,
        evidence: text.trim().slice(0, 120),
        note: `new public API in reviewed repo '${repo}'; requires an enumerated-surface argument listing existing public items that are missing`,
      })
    }
  }
  return findings
}

export function checkRepoDiff(diff: RepoDiff, config: Config): Finding[] {
  const out: Finding[] = []
  for (const file of diff.files) {
    if (file.binary) continue
    out.push(...checkFile(diff.repo, file, config))
  }

  const testsInDiff = diff.files.some(
    (f) => f.path.includes("test") || f.path.startsWith("tests/") || f.path.endsWith("tests.rs"),
  )
  if (!testsInDiff) {
    for (const file of diff.files) {
      if (!file.path.endsWith(".rs") || !/^src\//.test(file.path) || file.path.includes("test")) continue
      const adds = addedLines(file)
      const behavioral = adds.filter((a) => /^(pub\s+)?(async\s+)?(fn|impl|struct|enum|trait)\s|^\s+(pub\s+)?fn\s/.test(a.text.trim()))
      if (behavioral.length > 0) {
        out.push({
          rule: "RULE-8",
          severity: "review",
          repo: diff.repo,
          file: file.path,
          line: behavioral[0]?.line ?? null,
          evidence: `${behavioral.length} behavioral line(s) added in ${file.path}; no test file anywhere in this diff`,
          note: "new behavior ships with a test that fails without it; this repo-diff touches no tests",
        })
      }
    }
  }
  return dedupe(out)
}

export function checkCommitMessage(message: string, repo: string): Finding[] {
  const out: Finding[] = []
  for (const line of message.split("\n")) {
    if (AI_TRAILER.test(line)) {
      out.push({ rule: "RULE-6", severity: "block", repo, file: "(commit message)", line: null, evidence: line.trim().slice(0, 120), note: "AI-identifying trailer in commit message; house style bans them" })
    }
    if (EM_DASH.test(line)) {
      out.push({ rule: "RULE-6", severity: "block", repo, file: "(commit message)", line: null, evidence: line.trim().slice(0, 120), note: "em dash in commit message; house style bans em dashes" })
    }
  }
  return out
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of findings) {
    const key = `${f.rule}|${f.repo}|${f.file}|${f.line}|${f.evidence}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}
