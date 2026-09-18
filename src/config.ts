import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, dirname, resolve } from "node:path"
import { z } from "zod"
import { parseJsonc } from "./jsonc.js"
import { applyRuntimeOverridesFromDisk, type RuntimeOverrides } from "./overrides.js"

const bool = (def: boolean) => z.boolean().default(def)

const GatesSchema = z.object({
  plan: z.object({ inSpec: bool(true), ambiguity: bool(true), openQuestions: bool(true), oneWayDoors: bool(true) }).default({}),
  retrieval: z.object({ rerank: bool(true), topK: z.number().int().min(1).max(20).default(6) }).default({}),
  check: z
    .object({
      deterministic: bool(true),
      battery: bool(true),
      selfReport: bool(true),
      testQuality: bool(true),
      docDrift: bool(true),
      injectionDefense: bool(true),
    })
    .default({}),
  security: z
    .object({ trustBoundary: bool(true), severity: bool(true), alwaysHuman: z.array(z.string()).default(["keys", "seals", "digests"]) })
    .default({}),
  loop: z.object({ retryProgress: bool(true), errorSalience: bool(true), maxCycles: z.number().int().min(1).default(3) }).default({}),
  session: z.object({ endAudit: bool(true), nudge: bool(true), maxNudges: z.number().int().min(0).default(3) }).default({}),
})

const ThresholdsSchema = z.object({
  actionThreshold: z.number().min(0).max(1).default(0.8),
  reviewThreshold: z.number().min(0).max(1).default(0.5),
})

export const ConfigSchema = z.object({
  model: z.string().default("jev-1.13.0"),
  activePolicy: z.string().default("strict"),
  egress: z.object({ semantic: bool(true), warnOncePerSession: bool(true) }).default({}),
  corpus: z
    .object({
      spec: z.string().default("corpus/spec.md"),
      rules: z.string().default("corpus/rules.md"),
      divergences: z.string().default("corpus/divergences.md"),
      questions: z.string().default("corpus/questions.md"),
      plan: z.string().default("corpus/plan.md"),
      docs: z.array(z.string()).default([]),
      whitepaper: z.string().default("corpus/whitepaper.pdf"),
    })
    .default({}),
  gates: GatesSchema.default({}),
  policies: z.record(z.string(), ThresholdsSchema).default({ strict: {}, permissive: { actionThreshold: 0.9, reviewThreshold: 0.35 } }),
  cache: z.object({ dir: z.string().default(".aiwrangler") }).default({}),
  ledger: z.object({ path: z.string().default(".aiwrangler/ledger.jsonl") }).default({}),
  webui: z.object({ port: z.number().int().default(4478), bind: z.string().default("127.0.0.1") }).default({}),
  repos: z
    .object({
      super: z.string().default("."),
      members: z.array(z.string()).default([]),
      reviewed: z.array(z.string()).default([]),
    })
    .default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type GatePath = string

export interface LoadedConfig {
  config: Config
  root: string
  source: "explicit" | "discovered" | "user" | "defaults"
  path: string | null
  overrides: import("./overrides.js").RuntimeOverrides | null
}

export function expandPath(p: string, root: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1))
  if (isAbsolute(p)) return p
  return resolve(root, p)
}

export function findConfigFile(startDir: string): { path: string; source: "discovered" | "user" } | null {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, "aiwrangler.config.json")
    if (existsSync(candidate)) return { path: candidate, source: "discovered" }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const user = join(homedir(), ".config", "aiwrangler", "aiwrangler.config.json")
  if (existsSync(user)) return { path: user, source: "user" }
  return null
}

export function flattenGates(config: Config): Map<GatePath, boolean> {
  const flat = new Map<GatePath, boolean>()
  const walk = (obj: unknown, prefix: string) => {
    if (obj === null || typeof obj !== "object") return
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === "boolean") flat.set(path, value)
      else if (typeof value === "object" && !Array.isArray(value)) walk(value, path)
    }
  }
  walk(config.gates, "")
  return flat
}

export function applyGateFlag(config: Config, name: string, value: boolean): string[] {
  const flat = flattenGates(config)
  const applied: string[] = []
  for (const path of flat.keys()) {
    const leaf = path.split(".").pop() ?? path
    if (path === name || leaf === name) {
      const parts = path.split(".")
      let node: Record<string, unknown> = config.gates as unknown as Record<string, unknown>
      for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>
      node[parts[parts.length - 1]!] = value
      applied.push(path)
    }
  }
  if (applied.length === 0) {
    throw new Error(`unknown gate '${name}'. Known gates: ${[...flat.keys()].join(", ")}`)
  }
  return applied
}

function applyFlagList(config: Config, list: string, value: boolean): string[] {
  const applied: string[] = []
  const names = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const name of names) {
    applied.push(...applyGateFlag(config, name, value))
  }
  return applied
}

export function applyEnvOverrides(config: Config, env: Record<string, string | undefined> = process.env): Config {
  const next = structuredClone(config)
  if (env.AIWRANGLER_MODEL) next.model = env.AIWRANGLER_MODEL
  if (env.AIWRANGLER_POLICY) {
    if (!(env.AIWRANGLER_POLICY in next.policies)) {
      throw new Error(`AIWRANGLER_POLICY: unknown policy '${env.AIWRANGLER_POLICY}'. Known: ${Object.keys(next.policies).join(", ")}`)
    }
    next.activePolicy = env.AIWRANGLER_POLICY
  }
  if (env.AIWRANGLER_EGRESS) {
    const on = ["1", "true", "on", "yes"].includes(env.AIWRANGLER_EGRESS.toLowerCase())
    next.egress.semantic = on
  }
  if (env.AIWRANGLER_DISABLE) applyFlagList(next, env.AIWRANGLER_DISABLE, false)
  if (env.AIWRANGLER_ENABLE) applyFlagList(next, env.AIWRANGLER_ENABLE, true)
  return next
}

export function loadConfig(startDir: string, env: Record<string, string | undefined> = process.env): LoadedConfig {
  const explicit = env.AIWRANGLER_CONFIG
  let raw: unknown
  let root: string
  let source: LoadedConfig["source"]
  let path: string | null

  if (explicit) {
    path = expandPath(explicit, resolve(startDir))
    if (!existsSync(path)) throw new Error(`AIWRANGLER_CONFIG: file not found: ${path}`)
    raw = parseJsonc(readFileSync(path, "utf8"))
    root = dirname(path)
    source = "explicit"
  } else {
    const found = findConfigFile(startDir)
    if (found) {
      path = found.path
      raw = parseJsonc(readFileSync(found.path, "utf8"))
      root = dirname(found.path)
      source = found.source
    } else {
      raw = {}
      root = resolve(startDir)
      source = "defaults"
      path = null
    }
  }

  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    throw new Error(`invalid aiwrangler config at ${path ?? "defaults"}:\n${issues}`)
  }
  const { config, overrides } = applyRuntimeOverridesFromDisk(parsed.data, root)
  return { config: applyEnvOverrides(config, env), root, source, path, overrides }
}

export function activeThresholds(config: Config): { actionThreshold: number; reviewThreshold: number } {
  const policy = config.policies[config.activePolicy]
  if (!policy) throw new Error(`activePolicy '${config.activePolicy}' not defined in policies`)
  return policy
}
