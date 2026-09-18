#!/usr/bin/env node
import { spawn } from "node:child_process"
import { startWebui } from "./server.js"

function usage(): void {
  process.stdout.write(
    [
      "aiwrangler-webui: local observability + control dashboard for the aiwrangler gates",
      "",
      "usage: aiwrangler-webui [options] [start-dir]",
      "",
      "options:",
      "  --port <n>   port to listen on (default: from aiwrangler.config.json webui.port, else 4478)",
      "  --bind <ip>  address to bind (default 127.0.0.1; do not expose this outside localhost)",
      "  --open       open the dashboard in the default browser after starting",
      "  --help       show this help",
      "",
      "start-dir is the repo whose aiwrangler.config.json / .aiwrangler state the server uses",
      "(default: current directory; config is discovered upward like the gates do).",
      "All /api routes require the token printed on startup (also stored in <repo>/.aiwrangler/webui-token).",
      "",
    ].join("\n"),
  )
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open"
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true })
  child.on("error", () => {
    process.stdout.write(`could not open a browser automatically; open this URL manually: ${url}\n`)
  })
  child.unref()
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let port: number | undefined
  let bind: string | undefined
  let open = false
  let startDir = process.cwd()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") return usage()
    if (arg === "--port") port = Number(argv[++i])
    else if (arg === "--bind") bind = argv[++i]
    else if (arg === "--open") open = true
    else positional.push(arg)
  }
  if (positional.length > 0) startDir = positional[0]!

  const { url, close } = await startWebui({ startDir, ...(port ? { port } : {}), ...(bind ? { bind } : {}) })
  process.stdout.write(`aiwrangler webui listening: ${url}\n`)
  process.stdout.write(`token file: webui-token inside the .aiwrangler state dir (bound to localhost; keep it there)\n`)
  process.stdout.write(`stop with Ctrl-C; opencode and the webui are independent processes\n`)
  if (open) openInBrowser(url)
  process.on("SIGINT", () => {
    close()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    close()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`aiwrangler-webui: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
