// Built dual entrypoint contract: the V1 named export survives the build, the
// V2 default export carries id/setup without needing @opencode/plugin at
// runtime, and the package maps the ./server subpath opencode resolves for
// {"package": ...} plugins to the plugin entry. Also pins the package-root
// exports the external plugins import.
import { existsSync, readFileSync } from "node:fs"
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
// URL so `tsc --noEmit` on a fresh checkout (CI order: typecheck before
// build) never resolves against dist.
const plugin = (await import(new URL("../dist/plugin.js", import.meta.url).href)) as {
  WranglerWatchPlugin?: unknown
  default?: { id?: string; setup?: unknown; server?: unknown }
}
const rootExports = (await import(new URL("../dist/index.js", import.meta.url).href)) as Record<string, unknown>

check("V1 named export WranglerWatchPlugin is a function", typeof plugin.WranglerWatchPlugin === "function")
const def = plugin.default
check("default export is an object", typeof def === "object" && def !== null)

// The V2 half must not depend on @opencode/plugin resolving: opencode's
// package-plugin cache installs the package without optional peers, and its
// loader rejects a default export without id + setup.
check("default.id === \"aiwrangler.nudge\"", def?.id === "aiwrangler.nudge", `got ${JSON.stringify(def?.id)}`)
check("default.setup is a function", typeof def?.setup === "function")
check("default.server is a function (V1 object entrypoint)", typeof def?.server === "function")

// opencode resolves {"package": "@kodr/aiwrangler"} through the package's
// ./server export (then the root); 0.1.2 shipped neither and failed to load.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports?: Record<string, { import?: string }>
}
check(
  "exports map ./server -> dist/plugin.js (opencode package-plugin entry)",
  pkg.exports?.["./server"]?.import === "./dist/plugin.js",
  `got ${JSON.stringify(pkg.exports?.["./server"])}`,
)
check("exports map ./plugin -> dist/plugin.js (V1 named-export path)", pkg.exports?.["./plugin"]?.import === "./dist/plugin.js")

check("root export runDeterministic is a function", typeof rootExports.runDeterministic === "function")
check("root export formatFindings is a function", typeof rootExports.formatFindings === "function")
check("root export diffFingerprint is a function", typeof rootExports.diffFingerprint === "function")

if (failures > 0) {
  console.error(`verify:plugin: ${failures} failure(s)`)
  process.exit(1)
}
process.stdout.write("verify:plugin ok\n")
