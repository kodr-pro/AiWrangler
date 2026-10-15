// Offline self-check: run the check gate over this repo's own dirty state
// with egress off (deterministic-only). Usage:
//   AIWRANGLER_CONFIG=/path/to/selfcheck-config.json npx tsx scripts/selfcheck-mcp.ts [task]
import { loadConfig, loadCorpus, runCheck, formatReport } from "../src/index.js"
import { Jev } from "../src/jev/client.js"

const cfgPath = process.env.AIWRANGLER_CONFIG
if (!cfgPath) {
  console.error("set AIWRANGLER_CONFIG to a self-check config (repos.super pointing at this repo, egress.semantic=false)")
  process.exit(1)
}
const task = process.argv[2] ?? "self-check of dirty state"
const loaded = loadConfig(import.meta.dirname)
const corpus = loadCorpus(loaded.config, loaded.root)
const jev = new Jev(loaded.config, { cacheDir: loaded.root })
const report = await runCheck(loaded.config, loaded.root, corpus, jev, { task, sessionID: "selfcheck" })
console.log(formatReport(report))
process.exit(report.exitCode)
