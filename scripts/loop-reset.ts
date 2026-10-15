// Reset the retry-loop circuit breaker for a guarded repo (replaces the
// retired webui loop-reset button). Usage: npx tsx scripts/loop-reset.ts [dir]
import { loopResetGate } from "../src/core.js"

const dir = process.argv[2] ?? process.cwd()
console.log(loopResetGate(dir, "cli"))
