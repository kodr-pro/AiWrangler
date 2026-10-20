import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2PluginNS } from "@opencode/plugin"
import { findConfigFile, loadConfig, type LoadedConfig } from "./config.js"
import { runDeterministic, formatFindings } from "./gates/deterministic/index.js"
import { diffFingerprint } from "./loop.js"
import { setJevWarnSink } from "./jev/client.js"
import { Ledger } from "./ledger.js"

interface WatchState {
  lastFingerprint: string
  nudges: number
  greenAnnounced: boolean
}

// ---- V1 named export: unchanged ---------------------------------------------
// V1 consumers re-export this by name (see README, "OpenCode 1.x (legacy)").
export const WranglerWatchPlugin: V1Plugin = async ({ client, directory }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "aiwrangler-watch", level, message } }).catch(() => {})

  if (!directory || (!findConfigFile(directory) && !process.env.AIWRANGLER_CONFIG)) {
    return {}
  }

  let loaded
  try {
    loaded = loadConfig(directory)
  } catch (err) {
    void log("error", `aiwrangler config failed to load; watch plugin inactive: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
  const statePath = join(loaded.root, ".aiwrangler", "watch-state.json")

  setJevWarnSink((message) => {
    void log("warn", message)
    client.tui
      .showToast({ body: { title: "aiwrangler", message, variant: "warning", duration: 8000 } })
      .catch(() => {})
    try {
      new Ledger(loaded.config, loaded.root).append({ ts: new Date().toISOString(), kind: "notice", message })
    } catch {
      /* ledger unavailable; the app log above still captured it */
    }
  })
  let watch: WatchState = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
  try {
    if (existsSync(statePath)) watch = { ...watch, ...(JSON.parse(readFileSync(statePath, "utf8")) as WatchState) }
  } catch {
    watch = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
  }
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(watch), "utf8")
  }

  async function nudge(sessionID: string, text: string) {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
    } catch (err) {
      void log("warn", `nudge failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: Record<string, any> }
      if (e.type !== "session.idle") return
      const props = e.properties ?? {}
      const sessionID = String(props.sessionID ?? props.id ?? "")
      if (!sessionID) return

      try {
        const loaded = loadConfig(directory!)
        if (!loaded.config.gates.session.nudge) return
        const report = await runDeterministic(loaded.config, loaded.root, { cargo: false })
        const fingerprint = diffFingerprint(
          report.repoDiffs
            .flatMap((d) => d.files.map((f) => f.path + String(f.hunks.length)))
            .join("|"),
        )
        if (fingerprint === watch.lastFingerprint) return
        watch.lastFingerprint = fingerprint

        const blocking = report.findings.filter((f) => f.severity === "block" || f.severity === "human")
        if (blocking.length > 0 && watch.nudges < loaded.config.gates.session.maxNudges) {
          watch.nudges++
          watch.greenAnnounced = false
          save()
          await nudge(
            sessionID,
            [
              "aiwrangler gate: deterministic findings on the current dirty files. Fix these before finishing, then run the wrangler_check tool for the full battery:",
              "",
              formatFindings(blocking),
            ].join("\n"),
          )
          return
        }

        if (report.repoDiffs.length > 0 && blocking.length === 0 && !watch.greenAnnounced && watch.nudges > 0) {
          watch.greenAnnounced = true
          save()
          await nudge(
            sessionID,
            "aiwrangler gate: previous deterministic findings are resolved. Run the wrangler_check tool for the full semantic battery before declaring done.",
          )
        }
        if (report.repoDiffs.length === 0) {
          watch.nudges = 0
          watch.greenAnnounced = false
          save()
        }
      } catch (err) {
        void log("warn", `idle check error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

// ---- V2 plugin ----------------------------------------------------------------
//
// opencode V2 loads plugins per location and every instance sees the same
// server-wide event stream; the completion family is
// `session.execution.succeeded` (V1's `session.idle` never fires and is kept
// only as a deduped fallback). Event payloads live in `event.data`, and V2
// client methods wrap their payloads (`{ location?, data: [...] }` for lists,
// `{ data: {...} }` for singletons), so every read below unwraps defensively.
// These shapes were verified empirically against opencode 2.1.1; where the
// shipped types disagree, the runtime behavior wins.

type BusEvent = {
  type?: string
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
  location?: { directory?: string }
}

// The Jev warn sink is process-global, but one leader instance now serves
// multiple repos: currentRoot/currentLoaded point the sink and the per-repo
// plugin log at the repo the current sweep is working on.
let currentRoot: string | null = null
let currentLoaded: LoadedConfig | null = null

// console.error from plugin code does not reach opencode.log, and V1's
// client.app.log / client.tui.showToast do not exist in V2; keep our own
// trail beside the ledger, tail-truncated.
const pluginLog = (level: "debug" | "info" | "warn" | "error", message: string): void => {
  try {
    console.error(`[aiwrangler-nudge] ${level}: ${message}`)
    if (!currentRoot) return
    const logPath = join(currentRoot, ".aiwrangler", "plugin.log")
    appendFileSync(logPath, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`)
    if (statSync(logPath).size > 128 * 1024) {
      writeFileSync(logPath, readFileSync(logPath, "utf8").split("\n").slice(-300).join("\n"))
    }
  } catch {
    /* never break on log trouble */
  }
}

// The V2 plugin definition. `Plugin.define` is the identity function in
// @opencode/plugin 2.1.1, and opencode's package-plugin loader only requires
// the default export to carry `id` and `setup` (it resolves the package's
// `./server` export); the definition therefore stands on its own wherever the
// SDK cannot be imported, e.g. opencode's package-plugin cache, which installs
// the package without optional peers.
const v2Definition: V2PluginNS.Plugin = {
  id: "aiwrangler.nudge",
  async setup(ctx) {
    const states = new Map<string, WatchState>()
    const lastHandled = new Map<string, number>()

        // ---- single-actor lease -------------------------------------------------
        // V2 loads this plugin per location; every instance receives every
        // session's completion event. Unguarded, three loaded locations means
        // three sweeps, tripled nudges, and a burned maxNudges budget. One
        // lease holder sweeps; followers stay subscribed and take over within
        // <=15s of the leader disappearing (lease TTL 45s; the TTL is the
        // correctness mechanism, deletion in cleanup is an optimization).
        const me = randomUUID()
        const LEASE_KEY = "leader.lease" // plugin-scoped storage, shared across location instances
        let leader = false
        async function tryLead() {
          try {
            const cur = (await ctx.storage.get(LEASE_KEY)) as { id?: string; expires?: number } | undefined
            const now = Date.now()
            if (!cur || cur.id === me || (cur.expires ?? 0) < now) {
              await ctx.storage.set(LEASE_KEY, { id: me, expires: now + 45_000 })
              if (!leader) pluginLog("info", `sweep lease acquired (instance ${me.slice(0, 8)})`)
              leader = true
            } else {
              leader = false
            }
          } catch {
            leader = true // storage unavailable: rather sweep than go silent
          }
        }
        void tryLead()
        const leadTimer = setInterval(() => void tryLead(), 15_000)

        function stateFor(statePath: string): WatchState {
          const cached = states.get(statePath)
          if (cached) return cached
          let loaded: WatchState = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
          try {
            if (existsSync(statePath)) loaded = { ...loaded, ...(JSON.parse(readFileSync(statePath, "utf8")) as WatchState) }
          } catch {
            loaded = { lastFingerprint: "", nudges: 0, greenAnnounced: false }
          }
          states.set(statePath, loaded)
          return loaded
        }

        const save = (statePath: string, state: WatchState) => {
          mkdirSync(dirname(statePath), { recursive: true })
          writeFileSync(statePath, JSON.stringify(state), "utf8")
        }

        async function nudge(sessionID: string, text: string) {
          try {
            await ctx.session.prompt({ sessionID, text })
          } catch (err) {
            pluginLog("warn", `nudge failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // Resolve the repo directory from the event first (the session's
        // directory, not the plugin instance's), then from the session
        // record, unwrapped, because V2 wraps singleton payloads in `data`.
        async function directoryFor(sessionID: string, event: BusEvent): Promise<string | undefined> {
          const fromEvent = event.location?.directory
          if (fromEvent) return fromEvent
          try {
            const res = (await ctx.session.get({ sessionID })) as unknown as {
              data?: { location?: { directory?: string } }
              location?: { directory?: string }
            }
            const session = res?.data ?? res
            if (session?.location?.directory) return session.location.directory
          } catch {
            /* fall through */
          }
          return undefined
        }

        async function sweep(sessionID: string, event: BusEvent) {
          // dedupe execution.succeeded + session.idle fallback double-fire
          const now = Date.now()
          const at = lastHandled.get(sessionID) ?? 0
          if (now - at < 5_000) return
          lastHandled.set(sessionID, now)
          if (lastHandled.size > 1024) {
            for (const [key, ts] of lastHandled) if (ts < now - 60_000) lastHandled.delete(key)
          }

          const directory = await directoryFor(sessionID, event)
          if (!directory) return
          if (!findConfigFile(directory) && !process.env.AIWRANGLER_CONFIG) return

          let loaded: LoadedConfig
          try {
            loaded = loadConfig(directory)
          } catch {
            return // config problems are the MCP tools' business, not ours
          }
          if (!loaded.config.gates.session.nudge) return
          const statePath = join(loaded.root, ".aiwrangler", "watch-state.json")
          const watch = stateFor(statePath)

          // Point the process-global Jev warn sink and the plugin log at
          // this repo for the duration of the sweep.
          currentRoot = loaded.root
          currentLoaded = loaded

          try {
            const report = await runDeterministic(loaded.config, loaded.root, { cargo: false })
            const fingerprint = diffFingerprint(
              report.repoDiffs.flatMap((d) => d.files.map((f) => f.path + String(f.hunks.length))).join("|"),
            )
            const blocking = report.findings.filter((f) => f.severity === "block" || f.severity === "human")
            pluginLog(
              "info",
              `sweep session=${sessionID} root=${loaded.root} fingerprint=${fingerprint.slice(0, 12)} diffRepos=${report.repoDiffs.length} blocking=${blocking.length}`,
            )
            if (fingerprint === watch.lastFingerprint) return
            watch.lastFingerprint = fingerprint

            if (blocking.length > 0 && watch.nudges < loaded.config.gates.session.maxNudges) {
              watch.nudges++
              watch.greenAnnounced = false
              save(statePath, watch)
              await nudge(sessionID, [
                "aiwrangler gate: deterministic findings on the current dirty files. Fix these before finishing, then run the wrangler_check tool for the full battery:",
                "",
                formatFindings(blocking),
              ].join("\n"))
              return
            }
            if (report.repoDiffs.length > 0 && blocking.length === 0 && !watch.greenAnnounced && watch.nudges > 0) {
              watch.greenAnnounced = true
              save(statePath, watch)
              await nudge(sessionID, "aiwrangler gate: previous deterministic findings are resolved. Run the wrangler_check tool for the full semantic battery before declaring done.")
            }
            if (report.repoDiffs.length === 0) {
              watch.nudges = 0
              watch.greenAnnounced = false
              save(statePath, watch)
            }
          } catch (err) {
            pluginLog("warn", `sweep error: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // Process-global sink: log against the repo being swept and append a
        // notice to that repo's ledger. V1's client.tui.showToast is gone in
        // V2 and is not replaced.
        setJevWarnSink((message) => {
          pluginLog("warn", message)
          if (!currentRoot || !currentLoaded) return
          try {
            new Ledger(currentLoaded.config, currentRoot).append({ ts: new Date().toISOString(), kind: "notice", message })
          } catch {
            /* ledger unavailable; the plugin log above still captured it */
          }
        })

        const controller = new AbortController()
        void (async () => {
          for await (const event of ctx.event.subscribe({ signal: controller.signal }) as unknown as AsyncIterable<BusEvent>) {
            if (event.type !== "session.execution.succeeded" && event.type !== "session.idle") continue
            if (!leader) continue // followers stay subscribed for seamless takeover
            const props = (event.data ?? event.properties ?? {}) as Record<string, unknown>
            const sessionID = String(props.sessionID ?? props.id ?? "")
            if (!sessionID) continue
            await sweep(sessionID, event)
          }
        })().catch((err) => pluginLog("warn", `event stream ended: ${err instanceof Error ? err.message : String(err)}`))

        pluginLog("info", `nudge tripwire loaded (location ${ctx.location.directory})`)
        return () => {
          clearInterval(leadTimer)
          controller.abort()
          currentRoot = null
          currentLoaded = null
          setJevWarnSink(null)
          void (async () => {
            try {
              const cur = (await ctx.storage.get(LEASE_KEY)) as { id?: string } | undefined
              if (cur?.id === me) await ctx.storage.remove(LEASE_KEY)
            } catch {
              /* best effort: the 45s lease TTL self-heals */
            }
          })()
        }
      },
}

// Prefer the real SDK's `Plugin.define` when the host provides it (it may
// validate or wrap in newer versions); pass the definition through unchanged
// when the SDK is absent (V1-only consumers, opencode's package cache).
const v2Plugin = await import("@opencode/plugin")
  .then(({ Plugin }) => Plugin.define(v2Definition))
  .catch(() => v2Definition)

// Dual entrypoint: V2 reads `id`/`setup` and ignores `server()`; V1 1.18.29+
// reads `server()` on object entrypoints. Both halves are always present; the
// V2 half needs no SDK at runtime.
export default {
  ...(v2Plugin ?? {}),
  async server(input: Parameters<V1Plugin>[0]) {
    return WranglerWatchPlugin(input)
  },
}
