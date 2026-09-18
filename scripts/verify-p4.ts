// @ts-expect-error runtime-only smoke import; tools entry ships no d.ts by design
import { wrangler_config, wrangler_plan, wrangler_check } from "../dist/tools.js"
import { fixtureConfigPath } from "../evals/fixture.js"

process.env.AIWRANGLER_CONFIG = fixtureConfigPath

let failures = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ": " + detail : ""}`)
  }
}

const ctx = { directory: process.cwd(), worktree: process.cwd() }

console.log("P4 verification: opencode tool surface (smoke via dist)")
console.log("")

console.log("1. wrangler_config")
const cfg = await wrangler_config.execute({}, ctx as never)
check("config tool returns corpus summary", cfg.includes("corpus:") && cfg.includes("spec=6"), cfg.split("\n").find((l: string) => l.startsWith("corpus:")))
check("config tool lists gates", cfg.includes("inSpec") && cfg.includes("injectionDefense"))
console.log("")

console.log("2. wrangler_plan (live)")
const plan = await wrangler_plan.execute(
  { task: "switch committee certificate signing from FROST to MuSig2 in the worker crate, updating the signing path and tests" },
  ctx as never,
)
check("plan returns ACTION", plan.includes("AIWRANGLER PLAN:"), plan.split("\n")[0])
check("plan includes context pack", plan.includes("GROUND-TRUTH CONTEXT PACK"))
check("plan cites section IDs", /\[(SPEC-|RULE-|DIV-|Q-|DOOR-)/.test(plan))
console.log(plan.split("\n").slice(0, 6).join("\n"))
console.log("        ...")

console.log("")
console.log("3. wrangler_check")
const rep = await wrangler_check.execute({ task: "aiwrangler self-check smoke" }, ctx as never)
check("check returns verdict header", /^(AIWRANGLER (PASS|FIX REQUIRED|HUMAN REVIEW|DEGRADED))/m.test(rep), rep.split("\n")[0])
console.log(rep.split("\n").slice(0, 4).join("\n"))
console.log("        ...")

console.log("")
if (failures > 0) {
  console.log(`P4 FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log("P4 smoke PASSED: tools execute end-to-end from the built dist")
