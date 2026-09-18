import { loadConfig } from "../src/config.js"
import { loadCorpus } from "../src/groundtruth/corpus.js"
import { buildIndex, shortlist } from "../src/retrieval/shortlist.js"
import { Jev } from "../src/jev/client.js"
import { runPlanGate } from "../src/gates/plan/index.js"
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
console.log("P2 verification: retrieval + plan gate" + (live ? " (live Jev)" : " (offline only)"))
console.log("")

const loaded = loadConfig(process.cwd(), fixtureEnv())
const corpus = loadCorpus(loaded.config, loaded.root)
const jev = new Jev(loaded.config)

console.log("1. lexical shortlist")
const idx = buildIndex(corpus)
const sig = shortlist(idx, "which signature scheme signs committee certificates FROST MuSig2 BLS", 6).map((s) => s.section.id)
check("signature query finds signature sections", sig.some((id) => id.startsWith("DIV-") || id === "SPEC-12" || id.startsWith("Q-")), sig.join(","))
const mvcc = shortlist(idx, "MVCC multi-version concurrency control state versioning", 6).map((s) => s.section.id)
check("mvcc query finds SPEC-4", mvcc.includes("SPEC-4"), mvcc.join(","))
const door = shortlist(idx, "validator admission lease governance seats", 6).map((s) => s.section.id)
check("governance query finds SPEC-18", door.includes("SPEC-18"), door.join(","))
console.log("")

console.log("2. degraded mode (AIWRANGLER_EGRESS=off)")
const offEnv: Record<string, string | undefined> = fixtureEnv({ AIWRANGLER_EGRESS: "off" })
const loadedOff = loadConfig(process.cwd(), offEnv)
const corpusOff = loadCorpus(loadedOff.config, loadedOff.root)
const report = await runPlanGate(loadedOff.config, new Jev(loadedOff.config), corpusOff, {
  task: "add a unit test for canonical_bytes in the core crate",
})
check("degraded report returned", report.degraded === true && report.degradedReason === "egress-off")
check("degraded still has context pack", report.contextPack.sections.length > 0 || report.contextPack.rulings.length > 0)
check("degraded marks pass-with-reason", report.action === "pass" && report.reasons.length > 0)
console.log("")

if (live) {
  console.log("3. live plan gate: vague task")
  const vague = await runPlanGate(loaded.config, jev, corpus, {
    task: "make the receipts better",
  })
  check("vague task -> clarify", vague.action === "clarify", `${vague.action}: ${vague.reasons.join("; ")}`)
  check("verdicts recorded", vague.verdicts.length >= 3)
  console.log("        reasons: " + vague.reasons.join(" | ").slice(0, 200))

  console.log("")
  console.log("4. live plan gate: task touching an open question area")
  const sigTask = await runPlanGate(loaded.config, jev, corpus, {
    task:
      "switch committee certificate signing from FROST to MuSig2 in the worker crate, updating the signing path and tests; on malformed signatures return a SignatureError",
  })
  console.log(`        action=${sigTask.action}`)
  console.log("        reasons: " + sigTask.reasons.join(" | ").slice(0, 300))
  for (const v of sigTask.verdicts) console.log(`        ${v.question.padEnd(22)} ${v.noul.toFixed(2)} ${v.interpretation}${v.subject ? " [" + v.subject + "]" : ""}`)
  check("signature task surfaces open divergence or question", sigTask.reasons.some((r) => r.includes("Q-1") || r.includes("DIV-") || r.includes("divergence")) || sigTask.action !== "pass")

  console.log("")
  console.log("5. live plan gate: clean well-specified task")
  const clean = await runPlanGate(loaded.config, jev, corpus, {
    task:
      "add a unit test in the core crate that verifies canonical_bytes produces stable output for a fixed capnp struct; the test fails if the bytes change",
  })
  console.log(`        action=${clean.action} pack=${clean.contextPack.sections.map((s) => s.id).join(",")}`)
  for (const v of clean.verdicts) console.log(`        ${v.question.padEnd(22)} ${v.noul.toFixed(2)} ${v.interpretation}`)
  check("clean task -> pass", clean.action === "pass", clean.reasons.join("; "))
  check("usage recorded", (clean.usage?.inputTokens ?? 0) > 0)
} else {
  console.log("3-5. skipped (no TYPESAFE_API_KEY or AIWRANGLER_SKIP_LIVE=1)")
}

console.log("")
if (failures > 0) {
  console.log(`P2 FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log("P2 PASSED: retrieval shortlist, degraded mode" + (live ? ", live plan-gate verdicts" : ""))
