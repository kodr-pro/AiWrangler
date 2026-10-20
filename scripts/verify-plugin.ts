// Built dual entrypoint contract: the V1 named export survives the build and
// the V2 default export carries id/setup whenever @opencode/plugin resolves.
// Also pins the package-root exports the external plugins import.
import { existsSync } from "node:fs"
import { join } from "node:path"

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ok    ${name}\n`)
  } else {
    failures++
    process.stdout.write(`  FAIL  ${name}${detail ? `: ${detail}` : ""}\n`)
  }
}

const root = join(import.meta.dirname, "..")
const pluginDist = join(root, "dist", "plugin.js")
if (!existsSync(pluginDist)) {
  console.error("dist/plugin.js missing; run npm run build")
  process.exit(1)
}

// dist/plugin.js ships untyped (dts covers the package root only); import by
// URL so the module shape is asserted here, not borrowed from a .d.ts.
const plugin = (await import(new URL("../dist/plugin.js", import.meta.url).href)) as {
  WranglerWatchPlugin?: unknown
  default?: { id?: string; setup?: unknown; server?: unknown }
}
const rootExports = (await import("../dist/index.js")) as Record<string, unknown>

check("V1 named export WranglerWatchPlugin is a function", typeof plugin.WranglerWatchPlugin === "function")
const def = plugin.default
check("default export is an object", typeof def === "object" && def !== null)
check("default.server is a function (V1 object entrypoint)", typeof def?.server === "function")

// The V2 half only exists when the host SDK resolves (it does, from devDeps).
let v2Resolvable = true
try {
  await import("@opencode/plugin")
} catch {
  v2Resolvable = false
  process.stdout.write("  --    @opencode/plugin not resolvable; skipping V2 shape checks\n")
}
if (v2Resolvable) {
  check("default.id === \"aiwrangler.nudge\"", def?.id === "aiwrangler.nudge", `got ${JSON.stringify(def?.id)}`)
  check("default.setup is a function", typeof def?.setup === "function")
}

check("root export runDeterministic is a function", typeof rootExports.runDeterministic === "function")
check("root export formatFindings is a function", typeof rootExports.formatFindings === "function")
check("root export diffFingerprint is a function", typeof rootExports.diffFingerprint === "function")

if (failures > 0) {
  console.error(`verify:plugin: ${failures} failure(s)`)
  process.exit(1)
}
process.stdout.write("verify:plugin ok\n")
