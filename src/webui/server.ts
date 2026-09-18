import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, flattenGates, activeThresholds, expandPath } from "../config.js"
import { loadCorpus } from "../groundtruth/corpus.js"
import { sectionsOfKind } from "../groundtruth/precedence.js"
import { Ledger, type LedgerEntry } from "../ledger.js"
import { readRuntimeOverridesFile, writeRuntimeOverridesFile, clearRuntimeOverrides, RuntimeOverridesSchema, applyRuntimeOverrides } from "../overrides.js"
import { readDiffSnapshot } from "../gates/check/snapshot.js"
import { dirtySet } from "../git/diff.js"
import { ensureToken, verifyToken, tokenFromRequest } from "./token.js"
import { Watcher, watcherPaths, type WebuiEvent } from "./watcher.js"

export interface WebuiOptions {
  startDir: string
  port?: number
  bind?: string
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url))

export async function startWebui(opts: WebuiOptions): Promise<{ url: string; close: () => void }> {
  const loaded = loadConfig(opts.startDir)
  const root = loaded.root
  const stateDir = expandPath(loaded.config.cache.dir, root)
  const ledgerPath = expandPath(loaded.config.ledger.path, root)
  const token = ensureToken(stateDir)
  const port = opts.port ?? loaded.config.webui.port
  const bind = opts.bind ?? loaded.config.webui.bind

  const watcher = new Watcher(watcherPaths(stateDir, ledgerPath))
  watcher.start()

  const sseClients = new Set<ServerResponse>()

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    })
  })

  const broadcast = (event: WebuiEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) {
      try {
        client.write(payload)
      } catch {
        sseClients.delete(client)
      }
    }
  }
  watcher.on("event", broadcast)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname

    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'")
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("cache-control", "no-store")

    if (path === "/api/events") {
      if (!verifyToken(tokenFromRequest(url, req.headers.authorization), token)) return json(res, 401, { ok: false, error: "unauthorized" })
      res.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      })
      res.write("retry: 2000\n\n")
      sseClients.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n")
        } catch {
          /* dropped */
        }
      }, 15_000)
      heartbeat.unref?.()
      req.on("close", () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      })
      return
    }

    if (path.startsWith("/api/")) {
      if (!verifyToken(tokenFromRequest(url, req.headers.authorization), token)) return json(res, 401, { ok: false, error: "unauthorized" })
      return apiRoute(req, res, url)
    }

    return staticRoute(res, path)
  }

  async function apiRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const method = req.method ?? "GET"
    const fresh = loadConfig(opts.startDir)
    const { config } = fresh
    const ledger = new Ledger(config, root)

    if (method === "GET" && path === "/api/status") {
      const corpus = loadCorpus(config, root)
      let loop: unknown = { cycles: [] }
      try {
        loop = JSON.parse(readFileSync(join(stateDir, "loop-state.json"), "utf8"))
      } catch {
        /* absent */
      }
      let dirty: { repo: string; path: string }[] = []
      try {
        dirty = dirtySet(config, root)
          .flatMap((d) => d.files.map((f) => ({ repo: d.repo, path: f.path })))
          .slice(0, 500)
      } catch {
        /* git unavailable */
      }
      const counts = (["spec", "rule", "divergence", "question", "door", "paper", "doc"] as const).map((kind) => ({
        kind,
        n: sectionsOfKind(corpus, kind).length,
      }))
      return json(res, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        config: {
          model: config.model,
          activePolicy: config.activePolicy,
          policies: Object.keys(config.policies),
          thresholds: activeThresholds(config),
          egressSemantic: config.egress.semantic,
          source: fresh.source,
          path: fresh.path,
          overridesActive: fresh.overrides !== null,
          overrides: readRuntimeOverridesFile(config, root),
        },
        gates: [...flattenGates(config).entries()].map(([gate, on]) => ({ gate, on })),
        corpus: { hash: corpus.hash, counts, sources: corpus.sources },
        loop: { ...(typeof loop === "object" && loop !== null ? loop : { cycles: [] }), maxCycles: config.gates.loop.maxCycles },
        dirty,
      })
    }

    if (method === "GET" && path === "/api/ledger") {
      const maxEntries = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1000)
      const entries = ledger.read().slice(-maxEntries).reverse()
      return json(res, 200, { ok: true, entries })
    }

    if (method === "GET" && path.startsWith("/api/diffs/")) {
      const hash = path.slice("/api/diffs/".length)
      const snapshot = readDiffSnapshot(config, root, hash)
      if (snapshot === null) return json(res, 404, { ok: false, error: "snapshot not found" })
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      res.end(snapshot)
      return
    }

    if (method === "GET" && path === "/api/cache") {
      const cacheDir = join(stateDir, "cache")
      const entries: { key: string; usage: { inputTokens: number; outputTokens: number }; model: string; questions: string[] }[] = []
      try {
        for (const name of readdirSync(cacheDir)
          .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
          .sort()) {
          try {
            const parsed = JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as {
              model?: string
              usage?: { inputTokens: number; outputTokens: number }
              answers?: Record<string, unknown>
            }
            entries.push({
              key: name.replace(/\.json$/, ""),
              model: parsed.model ?? "?",
              usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
              questions: Object.keys(parsed.answers ?? {}),
            })
          } catch {
            /* skip corrupt cache entry */
          }
        }
      } catch {
        /* cache dir absent */
      }
      return json(res, 200, { ok: true, entries })
    }

    if (method === "GET" && path.startsWith("/api/cache/")) {
      const key = path.slice("/api/cache/".length).replace(/\.json$/, "")
      if (!/^[0-9a-f]{64}$/.test(key)) return json(res, 400, { ok: false, error: "bad cache key" })
      const file = join(stateDir, "cache", `${key}.json`)
      if (!existsSync(file)) return json(res, 404, { ok: false, error: "cache entry not found" })
      try {
        return json(res, 200, { ok: true, entry: JSON.parse(readFileSync(file, "utf8")) })
      } catch {
        return json(res, 500, { ok: false, error: "corrupt cache entry" })
      }
    }

    if (method === "GET" && path === "/api/corpus") {
      const corpus = loadCorpus(config, root)
      return json(res, 200, {
        ok: true,
        hash: corpus.hash,
        sources: corpus.sources,
        sections: corpus.sections.map((s) => ({
          id: s.id,
          kind: s.kind,
          title: s.title,
          status: s.status,
          precedence: s.precedence,
          ...(s.ruling ? { ruling: s.ruling.slice(0, 1200) } : {}),
          text: s.text.slice(0, 4000),
        })),
      })
    }

    if (method === "GET" && path === "/api/loop") {
      let loop: unknown = { cycles: [] }
      try {
        loop = JSON.parse(readFileSync(join(stateDir, "loop-state.json"), "utf8"))
      } catch {
        /* absent */
      }
      const acks = ledger.read().filter((e): e is Extract<LedgerEntry, { kind: "ack" }> => e.kind === "ack").slice(-20)
      return json(res, 200, { ok: true, loop, acks })
    }

    if (method === "PUT" && path === "/api/overrides") {
      const body = await readBody(req)
      const parsed = RuntimeOverridesSchema.safeParse(body.overrides ?? body)
      if (!parsed.success) return json(res, 400, { ok: false, error: "invalid overrides", issues: parsed.error.issues })
      try {
        applyRuntimeOverrides(config, parsed.data)
      } catch (err) {
        return json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      writeRuntimeOverridesFile(config, root, {
        version: 1,
        createdAt: new Date().toISOString(),
        ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim().slice(0, 300) } : {}),
        expiresOn: "pass",
        overrides: parsed.data,
      })
      ledger.append({
        ts: new Date().toISOString(),
        kind: "override",
        source: "webui",
        changes: parsed.data as Record<string, unknown>,
      })
      return json(res, 200, { ok: true, overrides: parsed.data, expiresOn: "pass" })
    }

    if (method === "DELETE" && path === "/api/overrides") {
      const existed = clearRuntimeOverrides(config, root)
      if (existed) {
        ledger.append({ ts: new Date().toISOString(), kind: "override", source: "webui", changes: { cleared: "manual" } })
      }
      return json(res, 200, { ok: true, cleared: existed })
    }

    if (method === "POST" && path === "/api/loop/reset") {
      try {
        readFileSync(join(stateDir, "loop-state.json"))
      } catch {
        return json(res, 404, { ok: false, error: "no loop state to reset" })
      }
      writeFileSync(join(stateDir, "loop-state.json"), JSON.stringify({ cycles: [] }), "utf8")
      ledger.append({ ts: new Date().toISOString(), kind: "notice", message: "loop state reset via webui" })
      return json(res, 200, { ok: true })
    }

    if (method === "POST" && path === "/api/ack") {
      const body = await readBody(req)
      const diffHash = typeof body.diffHash === "string" ? body.diffHash : ""
      const rules = Array.isArray(body.rules) ? body.rules.filter((r): r is string => typeof r === "string") : []
      if (!/^[0-9a-f]{16,64}$/.test(diffHash)) return json(res, 400, { ok: false, error: "invalid diffHash" })
      if (rules.length === 0) return json(res, 400, { ok: false, error: "rules must be a non-empty array (use [\"*\"] to ack all human findings)" })
      const known = ledger.read().some((e) => (e.kind === "check" || e.kind === "plan") && e.diffHash === diffHash)
      const inLoop = (() => {
        try {
          const loop = JSON.parse(readFileSync(join(stateDir, "loop-state.json"), "utf8")) as { cycles?: { diffHash?: string }[] }
          return (loop.cycles ?? []).some((c) => c.diffHash === diffHash)
        } catch {
          return false
        }
      })()
      if (!known && !inLoop) return json(res, 404, { ok: false, error: "diffHash not found in ledger or loop state" })
      const entry = {
        ts: new Date().toISOString(),
        kind: "ack" as const,
        diffHash,
        rules: rules.slice(0, 50),
        ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim().slice(0, 500) } : {}),
        by: "webui",
      }
      ledger.append(entry)
      return json(res, 200, { ok: true, ack: entry })
    }

    return json(res, 404, { ok: false, error: `no route ${method} ${path}` })
  }

  function staticRoute(res: ServerResponse, path: string): void {
    let rel = path === "/" ? "index.html" : path.slice(1)
    if (rel.includes("..")) return json(res, 400, { ok: false, error: "bad path" })
    const abs = normalize(resolve(PUBLIC_DIR, rel))
    if (!abs.startsWith(normalize(PUBLIC_DIR))) return json(res, 403, { ok: false, error: "forbidden" })
    if (!existsSync(abs) || abs.endsWith("/")) {
      rel = "index.html"
      return serveFile(res, join(PUBLIC_DIR, rel))
    }
    return serveFile(res, abs)
  }

  function serveFile(res: ServerResponse, abs: string): void {
    try {
      const content = readFileSync(abs)
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" })
      res.end(content)
    } catch {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
    }
  }

  await new Promise<void>((resolvePromise) => server.listen(port, bind, resolvePromise))
  const url = `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}/?token=${token}`

  return {
    url,
    close: () => {
      watcher.stop()
      server.close()
    },
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}
