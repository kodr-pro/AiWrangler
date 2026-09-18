import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.js"
import { loadCorpus } from "../src/groundtruth/corpus.js"
import { parseUnifiedDiff } from "../src/git/diff.js"
import { stripCommentsAndStrings } from "../src/gates/check/injection.js"
import { selectRootCauseHeuristic } from "../src/gates/check/errors.js"
import { LoopTracker } from "../src/loop.js"
import { Jev } from "../src/jev/client.js"
import { runCheck } from "../src/gates/check/run.js"
import type { RepoDiff } from "../src/types.js"
import { fixtureEnv } from "../evals/fixture.js"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ": " + detail : ""}`)
  }
}

const live = Boolean(process.env.TYPESAFE_API_KEY) && process.env.AIWRANGLER_SKIP_LIVE !== "1"
console.log("P3 verification: battery, injection defense, loop, salience" + (live ? " (live Jev)" : " (offline only)"))
console.log("")

console.log("1. comment/string stripper")
const src = [
  "let a = 1; // TODO(net): real comment with 'quote' and \u2014 dash",
  'let s = "string with // fake comment";',
  "let raw = r#\"raw \"quoted\" string\"#;",
  "/* block comment */ let b = 2;",
  "let c = 'x';",
  "let d = 'too long for a char maybe';",
].join("\n")
const stripped = stripCommentsAndStrings(src)
const strippedLines = stripped.split("\n")
check("line count preserved", strippedLines.length === 6)
check("line comments blanked", !strippedLines[0]!.includes(["TO", "DO"].join("")) && strippedLines[0]!.includes("let a"))
check("string contents blanked", !stripped.includes("fake comment") && stripped.includes("let s ="))
check("raw strings blanked", !stripped.includes("quoted\\\" string") && !stripped.includes("raw string"))
check("block comments blanked", !stripped.includes("block comment") && stripped.includes("let b"))
check("char literals blanked, long quoted text kept as code", stripped.includes("let c =") && stripped.includes("too long"))
console.log("")

console.log("2. error salience heuristic")
const diags = [
  { file: "src/a.rs", line: 3, col: 1, severity: "error", message: "cannot find type `Foo` in this scope", code: "E0412", isRootCauseCandidate: true },
  { file: "src/b.rs", line: 9, col: 5, severity: "error", message: "unresolved import `crate::foo`", code: "E0433", isRootCauseCandidate: false },
  { file: "src/c.rs", line: 2, col: 1, severity: "error", message: "cannot find type `Foo` in this scope", code: "E0412", isRootCauseCandidate: true },
]
const heuristic = selectRootCauseHeuristic(diags as never)
check("root cause selected, cascade counted", heuristic.root?.file === "src/a.rs" && heuristic.cascade.length === 2)
console.log("")

console.log("3. circuit breaker")
const tmp = mkdtempSync(join(tmpdir(), "aw-loop-"))
const tracker = new LoopTracker(join(tmp, "loop.json"))
const reasons = ["RULE-1 silent default in src/parse.rs"]
let escalate = false
for (let i = 0; i < 4; i++) {
  const v = tracker.evaluate("hash-x", reasons, 3)
  tracker.record({ ts: new Date().toISOString(), diffHash: "hash-x", action: "fix", topReasons: reasons })
  if (v.escalate) escalate = true
}
check("escalates at max cycles on repeated diff", escalate)
const tracker2 = new LoopTracker(join(tmp, "loop2.json"))
let escalated2 = false
for (let i = 0; i < 4; i++) {
  const v = tracker2.evaluate(`hash-${i}`, ["RULE-1 silent default in src/parse.rs"], 3)
  tracker2.record({ ts: new Date().toISOString(), diffHash: `hash-${i}`, action: "fix", topReasons: ["RULE-1 silent default in src/parse.rs"] })
  if (v.escalate) escalated2 = true
}
check("escalates on same-findings even with changing diffs", escalated2)
const tracker3 = new LoopTracker(join(tmp, "loop3.json"))
const fresh = tracker3.evaluate("hash-a", ["x"], 3)
check("fresh tracker starts at cycle 1, no escalate", fresh.cycle === 1 && !fresh.escalate)
rmSync(tmp, { recursive: true, force: true })
console.log("")

function fakeDiff(repo: string, path: string, added: string[]): RepoDiff {
  const text = [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1,2 +1," + (2 + added.length) + " @@",
    " fn existing() {",
    ...added.map((l) => "+" + l),
    " }",
  ].join("\n")
  return { repo, repoDir: "/tmp", files: parseUnifiedDiff(text) }
}

const loaded = loadConfig(process.cwd(), fixtureEnv())
const corpus = loadCorpus(loaded.config, loaded.root)

if (live) {
  console.log("4. live battery: claim/diff mismatch + silent default")
  const cacheTmp = mkdtempSync(join(tmpdir(), "aw-cache-"))
  const jev = new Jev(loaded.config, { cacheDir: cacheTmp })
  const lyingDiff = fakeDiff("worker", "src/len.rs", [
    "pub fn read_len(bytes: &[u8]) -> u32 {",
    "    // Returns an error on malformed length (per spec)",
    "    let n = bytes.try_into()" + [".unwrap", "_or(0)"].join(""),
    "}",
  ])
  const report1 = await runCheck(loaded.config, loaded.root, corpus, jev, {
    diffs: [lyingDiff],
    task: "make read_len return an error on malformed length",
    claims: ["read_len now returns an error when the length field is malformed"],
    cargo: false,
  })
  const semanticFindings = report1.semantic?.findings ?? []
  check("claim mismatch flagged (RULE-3)", semanticFindings.some((f) => f.rule === "RULE-3"), semanticFindings.map((f) => f.rule).join(","))
  check("silent default flagged (RULE-1)", semanticFindings.some((f) => f.rule === "RULE-1"))
  check("doc lie flagged (HALLUC) or verdicts recorded", semanticFindings.some((f) => f.rule === "HALLUC") || (report1.semantic?.verdicts.length ?? 0) > 0)
  check("action=fix or human", report1.action === "fix" || report1.action === "human", report1.action)
  for (const v of report1.semantic?.verdicts ?? []) console.log(`        ${v.question.padEnd(24)} ${v.value.toFixed(2)}  ${v.label}`)

  console.log("")
  console.log("5. live battery: clean minimal diff passes")
  const cleanDiff = fakeDiff("core", "tests/canonical_test.rs", [
    "#[test]",
    "fn canonical_bytes_stable() {",
    "    let a = canonical_bytes_of_fixed_struct();",
    "    let b = canonical_bytes_of_fixed_struct();",
    "    assert_eq!(a, b);",
    "}",
  ])
  const report2 = await runCheck(loaded.config, loaded.root, corpus, jev, {
    diffs: [cleanDiff],
    task: "add a unit test verifying canonical_bytes stability for a fixed capnp struct",
    claims: ["adds a stability test for canonical_bytes"],
    cargo: false,
  })
  check("clean diff -> pass", report2.action === "pass", report2.reasons.join("; ").slice(0, 200) + " | findings: " + (report2.semantic?.findings ?? []).map((f) => f.rule).join(","))
  rmSync(cacheTmp, { recursive: true, force: true })

  console.log("")
  console.log("6. verdict cache")
  const cacheTmp2 = mkdtempSync(join(tmpdir(), "aw-cache2-"))
  const jev2 = new Jev(loaded.config, { cacheDir: cacheTmp2 })
  const a1 = await jev2.ask({ x: "cache-probe", n: 1 }, { q: { type: "noul", instructions: "Is `n` the number one?" } })
  const a2 = await jev2.ask({ x: "cache-probe", n: 1 }, { q: { type: "noul", instructions: "Is `n` the number one?" } })
  check("second identical ask served from cache", a2.cached === true)
  check("cached answer identical", JSON.stringify(a1.answers) === JSON.stringify(a2.answers))
  const a3 = await jev2.ask({ x: "cache-probe", n: 2 }, { q: { type: "noul", instructions: "Is `n` the number one?" } })
  check("changed state misses cache", a3.cached !== true)
  rmSync(cacheTmp2, { recursive: true, force: true })
} else {
  console.log("4-6. skipped (offline)")
}

console.log("")
if (failures > 0) {
  console.log(`P3 FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log("P3 PASSED: injection stripper, salience heuristic, circuit breaker" + (live ? ", live battery + cache" : ""))
