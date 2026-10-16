import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/** Version from the nearest package.json, so the published server matches the npm package. */
export function packageVersion(): string {
  const pkg = require("../package.json") as { version?: unknown }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("aiwrangler: package.json has no version")
  }
  return pkg.version
}
