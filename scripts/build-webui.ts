import { build } from "esbuild"
import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = join(here, "..")
const outDir = join(rootDir, "dist", "webui", "public")
const frontendDir = join(rootDir, "src", "webui", "frontend")

await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(frontendDir, "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  outfile: join(outDir, "app.js"),
  logLevel: "info",
})

await copyFile(join(frontendDir, "index.html"), join(outDir, "index.html"))
await copyFile(join(frontendDir, "style.css"), join(outDir, "style.css"))

process.stdout.write(`webui bundle written to ${outDir}\n`)
