import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, flattenGates, activeThresholds } from "../src/config.js"
import { loadCorpus } from "../src/groundtruth/corpus.js"
import { sectionsOfKind, effectiveTruth } from "../src/groundtruth/precedence.js"
import { fixtureEnv, fixtureCorpusDir } from "../evals/fixture.js"

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ": " + detail : ""}`)
  }
}

const env: Record<string, string | undefined> = {}

console.log("P0 verification: AiWrangler")
console.log("")

console.log("1. config: defaults + JSONC + env overrides")
const empty = mkdtempSync(join(tmpdir(), "aw-empty-"))
const base = loadConfig(empty, env)
check("defaults load without a config file", base.config.model === "jev-1.13.0" && base.source === "defaults")
check("default corpus paths are repo-relative", base.config.corpus.spec === "corpus/spec.md")

const discovered = loadConfig(fixtureCorpusDir, env)
check("config discovered from directory", discovered.source === "discovered" && discovered.path !== null)

env.AIWRANGLER_POLICY = "permissive"
env.AIWRANGLER_EGRESS = "off"
env.AIWRANGLER_DISABLE = "docDrift,ambiguity"
const overridden = loadConfig(empty, env)
check("policy override", overridden.config.activePolicy === "permissive")
check("egress override off", overridden.config.egress.semantic === false)
const flat = flattenGates(overridden.config)
check("gate disable (leaf match)", flat.get("check.docDrift") === false && flat.get("plan.ambiguity") === false)
check("other gates untouched", flat.get("check.battery") === true && flat.get("plan.inSpec") === true)
delete env.AIWRANGLER_POLICY
delete env.AIWRANGLER_EGRESS
delete env.AIWRANGLER_DISABLE

env.AIWRANGLER_DISABLE = "nonexistentGate"
try {
  loadConfig(empty, env)
  check("unknown gate name errors clearly", false)
} catch (err) {
  const msg = err instanceof Error ? err.message : ""
  check("unknown gate name errors clearly", msg.includes("unknown gate") && msg.includes("Known gates"))
}
delete env.AIWRANGLER_DISABLE

const tmp = mkdtempSync(join(tmpdir(), "aw-bad-"))
writeFileSync(join(tmp, "aiwrangler.config.json"), '{ "model": 123, /* jsonc comment */ "gates": { "plan": { "ambiguity": "yes" } } }')
try {
  loadConfig(tmp, env)
  check("invalid config errors with field path", false)
} catch (err) {
  const msg = err instanceof Error ? err.message : ""
  check("invalid config errors with field path", msg.includes("model") && msg.includes("ambiguity"), msg.split("\n")[0])
}
rmSync(tmp, { recursive: true, force: true })

const restored = loadConfig(process.cwd(), fixtureEnv())
const thresholds = activeThresholds(restored.config)
check("strict thresholds", thresholds.actionThreshold === 0.8 && thresholds.reviewThreshold === 0.5)
rmSync(empty, { recursive: true, force: true })
console.log("")

console.log("2. corpus: parse fixture ground truth")
const t0 = Date.now()
const corpus = loadCorpus(restored.config, restored.root)
const ms = Date.now() - t0
const spec = sectionsOfKind(corpus, "spec")
const rules = sectionsOfKind(corpus, "rule")
const divergences = sectionsOfKind(corpus, "divergence")
const questions = sectionsOfKind(corpus, "question")
const doors = sectionsOfKind(corpus, "door")
const paper = sectionsOfKind(corpus, "paper")
const ruled = effectiveTruth(corpus)
check(`6 spec sections`, spec.length === 6, `got ${spec.length}`)
check(`10 review rules`, rules.length === 10, `got ${rules.length}`)
check(`3 divergence entries`, divergences.length === 3, `got ${divergences.length}`)
check(`3 questions`, questions.length === 3, `got ${questions.length}`)
check(`one-way doors present`, doors.length === 2, `got ${doors.length}`)
check(`2 ruled divergences`, divergences.filter((d) => d.status === "ruled").length === 2)
check(`1 answered question`, questions.filter((q) => q.status === "answered").length === 1)
check(`ruled set = rulings only`, ruled.length === divergences.filter((d) => d.status === "ruled").length + questions.filter((q) => q.status === "answered").length)
check(`no paper file -> no paper sections`, paper.length === 0 && corpus.paperText === "")
check(`all sections have ids+precedence`, corpus.sections.every((s) => s.id && s.precedence >= 0 && s.precedence <= 4))
console.log(`        (loaded ${corpus.sections.length} sections from ${corpus.sources.length} sources in ${ms}ms)`)

console.log("")
console.log("3. corpus: missing files tolerated")
const bare = mkdtempSync(join(tmpdir(), "aw-bare-"))
const bareLoaded = loadConfig(bare, env)
const bareCorpus = loadCorpus(bareLoaded.config, bareLoaded.root)
check("no corpus files -> empty corpus, no throw", bareCorpus.sections.length === 0 && bareCorpus.sources.length === 0)
check("empty corpus hash stable", bareCorpus.hash === loadCorpus(bareLoaded.config, bareLoaded.root).hash)
rmSync(bare, { recursive: true, force: true })
console.log("")

console.log("4. corpus: hash stability")
const corpus2 = loadCorpus(restored.config, restored.root)
check("hash stable across loads", corpus.hash === corpus2.hash)
console.log(`        corpus hash: ${corpus.hash.slice(0, 16)}`)

console.log("")
if (failures > 0) {
  console.log(`P0 FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log("P0 PASSED: config round-trip, corpus parse, stable hash")
