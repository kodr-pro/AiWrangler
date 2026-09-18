import { parseUnifiedDiff } from "../src/git/diff.js"
import { checkRepoDiff, checkCommitMessage } from "../src/gates/deterministic/rules.js"
import { loadConfig } from "../src/config.js"
import type { Finding, RepoDiff } from "../src/types.js"
import { recentCommits, commitDiff, repoDirs } from "../src/git/diff.js"
import { expandPath } from "../src/config.js"
import { fixtureEnv } from "../evals/fixture.js"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ": " + detail : ""}`)
  }
}

function diffOf(repo: string, path: string, added: string[]): RepoDiff {
  const text = [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    "--- a/" + path,
    "+++ b/" + path,
    "@@ -1,3 +1," + (3 + added.length) + " @@",
    " context line",
    ...added.map((l) => "+" + l),
    " trailing context",
  ].join("\n")
  return { repo, repoDir: "/tmp", files: parseUnifiedDiff(text) }
}

console.log("P1 verification: deterministic gate")
console.log("")

const loaded = loadConfig(process.cwd(), fixtureEnv())

console.log("1. diff parsing")
const parsed = parseUnifiedDiff(
  [
    "diff --git a/src/foo.rs b/src/foo.rs",
    "index 123..456 100644",
    "--- a/src/foo.rs",
    "+++ b/src/foo.rs",
    "@@ -10,4 +10,6 @@ fn existing()",
    "     let a = 1;",
    "+    let b = 2;",
    "-    let c = 3;",
    "+    let d = 4;",
    " }",
  ].join("\n"),
)
check("one file parsed", parsed.length === 1)
check("hunk with add/del/ctx", parsed[0]!.hunks[0]!.lines.length === 5)
check("add lines numbered", parsed[0]!.hunks[0]!.lines.filter((l) => l.kind === "add").every((l) => typeof l.newLine === "number"))
console.log("")

console.log("2. seeded rule violations")
const EM = String.fromCharCode(0x2014)
const UO0 = [".unwrap", "_or(0);"].join("")
const UOD = [".unwrap", "_or_default();"].join("")
const ERR0 = ["Err(_", ") => 0,"].join("")
const CROSS = ['    include_str!("../../co', 're/schema.capnp");'].join("")
const DEFER = ["// TO", "DO fix this"].join("")
const DECL = ["const MAX_F", "UEL_PER_TX: u64 = 10_000;"].join("")
const seeded: { name: string; repo: string; path: string; lines: string[]; rule: string; severity: string }[] = [
  { name: "RULE-1 unwrap_or(0)", repo: "worker", path: "src/lib.rs", lines: ["    let n = bytes" + UO0], rule: "RULE-1", severity: "review" },
  { name: "RULE-1 unwrap_or_default", repo: "net", path: "src/lib.rs", lines: ["    let v = x" + UOD], rule: "RULE-1", severity: "review" },
  { name: "RULE-1 error-to-literal", repo: "core", path: "src/lib.rs", lines: ["        " + ERR0], rule: "RULE-1", severity: "review" },
  { name: "RULE-6 em dash", repo: "cli", path: "src/main.rs", lines: ["// this is a note " + EM + " with an em dash"], rule: "RULE-6", severity: "block" },
  { name: "RULE-6 cross-repo path", repo: "net", path: "src/lib.rs", lines: [CROSS], rule: "RULE-6", severity: "review" },
  { name: "RULE-7 untagged deferred marker", repo: "store", path: "src/lib.rs", lines: ["    " + DEFER], rule: "RULE-7", severity: "review" },
  { name: "RULE-10 seal path", repo: "net", path: "src/seal.rs", lines: ["    pub fn verify() {}"], rule: "RULE-10", severity: "human" },
  { name: "RULE-2 pub fn in reviewed repo", repo: "api", path: "src/lib.rs", lines: ["pub fn new_endpoint() {}"], rule: "RULE-2", severity: "review" },
  { name: "RULE-8 behavior without test", repo: "worker", path: "src/engine.rs", lines: ["pub fn run_engine(x: u32) -> u32 {", "    x + 1", "}"], rule: "RULE-8", severity: "review" },
  { name: "RULE-9 fuel decl", repo: "worker", path: "src/fuel.rs", lines: [DECL], rule: "RULE-9", severity: "review" },
]
for (const s of seeded) {
  const findings = checkRepoDiff(diffOf(s.repo, s.path, s.lines), loaded.config)
  const hit = findings.find((f) => f.rule === s.rule && f.severity === s.severity)
  check(s.name, hit !== undefined, findings.map((f) => `${f.rule}:${f.severity}`).join(",") || "no findings")
}
console.log("")

console.log("3. clean code produces no findings")
const clean = checkRepoDiff(
  diffOf(
    "worker",
    "src/verify.rs",
    ["    let n: u32 = parse_len(&bytes)?;", "    // TODO(worker): once fuel metering lands, charge here", "    let digest = blake3_digest(&n.to_le_bytes())?;"],
  ),
  loaded.config,
)
check("clean diff -> 0 findings", clean.length === 0, clean.map((f) => f.rule).join(","))
const cleanWithTest = checkRepoDiff(
  diffOf("worker", "tests/engine_test.rs", ["#[test]", "fn engine_runs() {", "    assert!(true);", "}"]),
  loaded.config,
)
check("test-only diff -> 0 findings", cleanWithTest.length === 0)
console.log("")

console.log("4. rule-8 suppressed when tests exist in same repo-diff")
const withTests: RepoDiff = {
  repo: "worker",
  repoDir: "/tmp",
  files: [
    ...diffOf("worker", "src/engine.rs", ["pub fn run(x: u32) -> u32 { x + 1 }"]).files,
    ...diffOf("worker", "tests/engine_test.rs", ["#[test]", "fn runs() {}"]).files,
  ],
}
const r8 = checkRepoDiff(withTests, loaded.config)
check("no RULE-8 when tests touched", !r8.some((f) => f.rule === "RULE-8"))
console.log("")

console.log("5. commit message checks")
const msgFindings = checkCommitMessage("fix engine\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "net")
check("AI trailer caught", msgFindings.some((f) => f.rule === "RULE-6" && f.note.includes("trailer")))
const cleanMsg = checkCommitMessage("fix engine\n\nUses the designed route; no longer defaults.", "net")
check("clean message passes", cleanMsg.length === 0)
console.log("")

console.log("6. clean repo history (recent commits, block findings must be 0)")
const superPath = expandPath(loaded.config.repos.super, loaded.root)
const dirs = repoDirs(loaded.config, loaded.root)
let totalCommits = 0
let blocks = 0
let reviews = 0
let humans = 0
for (const { repo, dir } of dirs.slice(0, 5)) {
  const commits = recentCommits(dir, 10)
  for (const c of commits) {
    totalCommits++
    const files = commitDiff(dir, c.sha)
    if (files.length === 0) continue
    const findings = checkRepoDiff({ repo, repoDir: dir, files }, loaded.config)
    for (const f of findings) {
      if (f.severity === "block") blocks++
      else if (f.severity === "review") reviews++
      else humans++
    }
  }
}
check("history scanned", totalCommits >= 1, `only ${totalCommits}`)
check("zero block findings on clean history", blocks === 0, `${blocks} block findings`)
console.log(`        scanned ${totalCommits} commits across ${Math.min(dirs.length, 5)} repos: block=${blocks} review=${reviews} human=${humans}`)
void superPath

console.log("")
if (failures > 0) {
  console.log(`P1 FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log("P1 PASSED: rule detection, suppression logic, clean history")
