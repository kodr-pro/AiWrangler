import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.js"
import { loadCorpus } from "../src/groundtruth/corpus.js"
import { runCheck } from "../src/gates/check/run.js"
import type { Jev, JevResult } from "../src/jev/client.js"
import { Ledger } from "../src/ledger.js"
import { writeRuntimeOverridesFile, readRuntimeOverridesFile } from "../src/overrides.js"

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ok    ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL  ${name}${detail ? `: ${detail}` : ""}\n`)
  }
}

const fixture = join(fileURLToPath(new URL("..", import.meta.url)), ".verify-fixture")
rmSync(fixture, { recursive: true, force: true })
mkdirSync(join(fixture, ".aiwrangler"), { recursive: true })

writeFileSync(
  join(fixture, "aiwrangler.config.json"),
  JSON.stringify({
    model: "stub",
    egress: { semantic: true, warnOncePerSession: false },
    corpus: {
      spec: "corpus/spec.md",
      rules: "corpus/rules.md",
      divergences: "corpus/divergences.md",
      questions: "corpus/questions.md",
      plan: "corpus/plan.md",
      docs: [],
      whitepaper: "corpus/whitepaper-absent.pdf",
    },
    cache: { dir: ".aiwrangler" },
    ledger: { path: ".aiwrangler/ledger.jsonl" },
    repos: { super: fixture, members: [], reviewed: [] },
    gates: { session: { nudge: false } },
  }),
)
mkdirSync(join(fixture, "corpus"), { recursive: true })
writeFileSync(join(fixture, "corpus/spec.md"), "1. Digests must be verified before use (IV)\n\n  Content digests are checked against the declared value.\n")
writeFileSync(join(fixture, "corpus/rules.md"), "10. Keys, seals, digests, disclosure\n\n  Anything touching keys, seals, digests, or disclosure leaves requires human eyes even if it looks correct.\n")
writeFileSync(join(fixture, "corpus/divergences.md"), "# Divergence Register\n\n(empty for verify)\n")
writeFileSync(join(fixture, "corpus/questions.md"), "# Open Questions\n\n(empty for verify)\n")
writeFileSync(join(fixture, "corpus/plan.md"), "# Plan\n\n(empty for verify)\n")
writeFileSync(join(fixture, ".aiwrangler/whitepaper.txt"), "cached whitepaper text for the verify fixture; no extraction needed\n")

const stubJev: Jev = {
  unavailable: () => null,
  model: "stub",
  async ask(): Promise<JevResult> {
    return { model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, answers: {} }
  },
} as unknown as Jev

const loaded = loadConfig(fixture)
const corpus = loadCorpus(loaded.config, loaded.root)

const digestDiff = [
  {
    repo: "worker",
    repoDir: fixture,
    files: [
      {
        path: "src/ocid.rs",
        binary: false,
        hunks: [
          { header: "@@ -1,1 +1,2 @@", lines: [{ kind: "add" as const, text: "pub fn blob_digest(p: &str) -> Result<[u8; 32], String> {", newLine: 171 }] },
        ],
      },
      {
        path: "src/ocid.rs.test",
        binary: false,
        hunks: [
          { header: "@@ -0,0 +1,2 @@", lines: [{ kind: "add" as const, text: "fn blob_digest_parses_hex_path() {", newLine: 1 }] },
        ],
      },
    ],
  },
]

process.stdout.write("verify-webui: gate-side behavior for the webui control plane\n")

const r1 = await runCheck(loaded.config, loaded.root, corpus, stubJev, { diffs: digestDiff, task: "verify ack flow" })
check("run1: RULE-10 fires with severity human", r1.deterministic.findings.some((f) => f.rule === "RULE-10" && f.severity === "human"))
check("run1: action is human", r1.action === "human", `got ${r1.action}`)
check("run1: diffHash present", typeof r1.diffHash === "string" && r1.diffHash.length === 64)
check("run1: ledger reasons recorded", (() => {
  const entries = new Ledger(loaded.config, loaded.root).read()
  const last = entries[entries.length - 1]
  return last !== undefined && last.kind === "check" && (last.reasons?.length ?? 0) > 0
})())
check("run1: snapshot written", existsSync(join(fixture, ".aiwrangler", "diffs", `${r1.diffHash}.txt`)))

new Ledger(loaded.config, loaded.root).append({
  ts: new Date().toISOString(),
  kind: "ack",
  diffHash: r1.diffHash!,
  rules: ["RULE-10"],
  by: "verify-script",
})

const r2 = await runCheck(loaded.config, loaded.root, corpus, stubJev, { diffs: digestDiff, task: "verify ack flow" })
check("run2: ack satisfied the human finding", r2.acknowledged >= 1 && r2.action === "pass", `action=${r2.action} acknowledged=${r2.acknowledged}`)
check("run2: finding annotated", r2.deterministic.findings.some((f) => f.rule === "RULE-10" && f.acknowledged === true))

writeRuntimeOverridesFile(loaded.config, loaded.root, {
  version: 1,
  createdAt: new Date().toISOString(),
  expiresOn: "pass",
  overrides: { gates: { battery: false } },
})
const r3 = await runCheck(loaded.config, loaded.root, corpus, stubJev, { diffs: digestDiff, task: "verify override expiry" })
check("run3: overrides expired on pass", r3.action === "pass" && readRuntimeOverridesFile(loaded.config, loaded.root) === null)
check("run3: expiry audited in ledger", (() => {
  const entries = new Ledger(loaded.config, loaded.root).read()
  return entries.some((e) => e.kind === "override" && e.source === "gate")
})())

const vacuousDiff = [
  {
    repo: "(super)",
    repoDir: fixture,
    files: [
      {
        path: ".gitignore",
        binary: false,
        hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "add" as const, text: "/.aiwrangler/", newLine: 1 }] }],
      },
    ],
  },
]
const r4 = await runCheck(loaded.config, loaded.root, corpus, stubJev, { diffs: vacuousDiff, task: "verify vacuous" })
check("run4: vacuous pass routed to degraded", r4.action === "degraded" && r4.degradedReason === "vacuous", `action=${r4.action} reason=${r4.degradedReason}`)
check("run4: vacuous reason recorded", r4.reasons.some((r) => r.startsWith("vacuous check")))

const lastCheck = readFileSync(join(fixture, ".aiwrangler", "ledger.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { kind: string; files?: unknown[]; examinedFiles?: unknown; sessionID?: string; overridesActive?: boolean })
  .filter((e) => e.kind === "check")
  .pop()
check("ledger: files summary present", Array.isArray(lastCheck?.files))
check("ledger: examinedFiles present", typeof lastCheck?.examinedFiles === "number")
check("ledger: overridesActive present", typeof lastCheck?.overridesActive === "boolean")

const withSession = await runCheck(loaded.config, loaded.root, corpus, stubJev, { diffs: digestDiff, task: "session tag", sessionID: "ses_verify_1" })
check("sessionID threaded into report", withSession.sessionID === "ses_verify_1")
const sessionLedgered = new Ledger(loaded.config, loaded.root).read().some((e) => e.kind === "check" && e.sessionID === "ses_verify_1")
check("sessionID threaded into ledger", sessionLedgered)

if (failures > 0) {
  process.stdout.write(`\nverify-webui: ${failures} FAILURE(S)\n`)
  process.exit(1)
}
process.stdout.write("\nverify-webui: all checks passed\n")
