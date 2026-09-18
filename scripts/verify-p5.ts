import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { loadConfig } from "../src/config.js"
import { loadCorpus } from "../src/groundtruth/corpus.js"
import { Jev } from "../src/jev/client.js"
import { runCheck } from "../src/gates/check/run.js"
import { checkCommitMessage } from "../src/gates/deterministic/rules.js"
import { recentCommits, commitDiff, git, repoDirs } from "../src/git/diff.js"
import { expandPath } from "../src/config.js"
import { SEEDED, type GoldenCase } from "../evals/fixtures.js"
import { fixtureEnv, tmpCacheDir } from "../evals/fixture.js"

const live = Boolean(process.env.TYPESAFE_API_KEY) && process.env.AIWRANGLER_SKIP_LIVE !== "1"
const MINED_PER_REPO = Number(process.env.P5_MINED ?? 3)

let tp = 0
let fn = 0
let fp = 0
let tn = 0
const perRule = new Map<string, { hit: number; missed: number }>()

function record(caseLabel: GoldenCase["label"], flagged: boolean, hitRules: string[], expected: string[]) {
  if (caseLabel === "should_flag") {
    if (flagged) {
      tp++
      for (const r of expected) perRule.set(r, { hit: (perRule.get(r)?.hit ?? 0) + 1, missed: perRule.get(r)?.missed ?? 0 })
    } else {
      fn++
      for (const r of expected) perRule.set(r, { hit: perRule.get(r)?.hit ?? 0, missed: (perRule.get(r)?.missed ?? 0) + 1 })
    }
  } else {
    if (flagged) {
      fp++
    } else tn++
  }
}

console.log("P5 verification: golden set + calibration" + (live ? " (live Jev)" : " (deterministic only)"))
console.log("")

const loaded = loadConfig(process.cwd(), fixtureEnv())
const corpus = loadCorpus(loaded.config, loaded.root)
const cacheTmp = tmpCacheDir()
const jev = new Jev(loaded.config, { cacheDir: cacheTmp })

console.log("1. seeded golden cases")
for (const c of SEEDED) {
  const report = await runCheck(loaded.config, loaded.root, corpus, jev, {
    diffs: c.diffs,
    ...(c.task ? { task: c.task } : {}),
    ...(c.claims ? { claims: c.claims } : {}),
    ...(c.agentSummary ? { agentSummary: c.agentSummary } : {}),
    ...(c.toolOutput ? { toolOutput: c.toolOutput } : {}),
    cargo: false,
  })
  const rules = [...report.deterministic.findings, ...(report.semantic?.findings ?? [])].map((f) => f.rule)
  const flagged = report.action === "fix" || report.action === "human"
  const caught = c.expectedRules.filter((r) => rules.includes(r))
  record(c.label, flagged, caught, c.expectedRules)
  const status = c.label === "should_flag" ? (flagged ? "flagged" : "MISSED") : flagged ? "FALSE-POSITIVE" : "clean"
  const detail = c.label === "should_flag" ? ` caught=[${caught.join(",")}] expected=[${c.expectedRules.join(",")}]` : ` rules=[${rules.join(",")}]`
  console.log(`  ${status.padEnd(15)} ${c.id}${detail}`)
}
console.log("")

console.log("2. mined clean history across all repos (deterministic + " + (live ? "semantic" : "no semantic") + ")")
const dirs = repoDirs(loaded.config, loaded.root)
let mined = 0
const minedFps: string[] = []
for (const { repo, dir } of dirs) {
  const commits = recentCommits(dir, MINED_PER_REPO + 4, "main").filter((c) => !/^Merge /.test(c.subject))
  let used = 0
  for (const c of commits) {
    if (used >= MINED_PER_REPO) break
    const files = commitDiff(dir, c.sha)
    if (files.length === 0) continue
    used++
    mined++
    const msg = git(dir, ["log", "-1", "--format=%B", c.sha]).stdout
    const claims = msg
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12)
      .slice(0, 4)
    const report = await runCheck(
      loaded.config,
      loaded.root,
      corpus,
      jev,
      {
        diffs: [{ repo, repoDir: dir, files }],
        ...(claims.length > 0 ? { claims } : {}),
        cargo: false,
      },
    )
    const blocking = [...report.deterministic.findings, ...(report.semantic?.findings ?? [])].filter(
      (f) => f.severity === "block" || f.severity === "human" && f.rule !== "RULE-10" && f.rule !== "SEVERITY",
    )
    const msgFindings = checkCommitMessage(msg, repo)
    const flagged =
      blocking.length > 0 ||
      msgFindings.some((f) => f.severity === "block" && f.note.includes("trailer"))
    record("should_pass", flagged, [], [])
    if (flagged) {
      minedFps.push(`${repo}@${c.sha.slice(0, 8)}: ${blocking.map((f) => `${f.rule}:${f.note.slice(0, 60)}`).join(" | ")}`)
    }
  }
}
console.log(`  mined ${mined} merged commits across ${dirs.length} repos`)
for (const fp of minedFps) console.log(`  FP: ${fp}`)
console.log("")

const precision = tp / Math.max(tp + fp, 1)
const recall = tp / Math.max(tp + fn, 1)
console.log("3. confusion matrix")
console.log(`  true-positive=${tp}  false-negative=${fn}  false-positive=${fp}  true-negative=${tn}`)
console.log(`  precision=${precision.toFixed(2)}  recall=${recall.toFixed(2)}`)
console.log("  per-rule recall:")
for (const [rule, { hit, missed }] of [...perRule].sort()) {
  console.log(`    ${rule.padEnd(12)} hit=${hit} missed=${missed}`)
}

mkdirSync("evals", { recursive: true })
writeFileSync(
  "evals/report.json",
  JSON.stringify({ ts: new Date().toISOString(), live, mined, tp, fn, fp, tn, perRule: Object.fromEntries(perRule) }, null, 2),
)

console.log("")
const seededRecallOk = tp === SEEDED.filter((c) => c.label === "should_flag").length
const cleanOk = fp === 0
if (!seededRecallOk || !cleanOk) {
  console.log(`P5 ${seededRecallOk ? "" : "recall incomplete; "}${cleanOk ? "" : "false positives present;"} report written to evals/report.json`)
  rmSync(cacheTmp, { recursive: true, force: true })
  process.exit(1)
}
console.log("P5 PASSED: 100% seeded catch, 0 false positives; report in evals/report.json")
rmSync(cacheTmp, { recursive: true, force: true })
void expandPath
