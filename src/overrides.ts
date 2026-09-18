import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { z } from "zod"
import type { Config } from "./config.js"
import { applyGateFlag, expandPath } from "./config.js"

export const OVERRIDES_FILENAME = "runtime-overrides.json"

export const RuntimeOverridesSchema = z.object({
  activePolicy: z.string().optional(),
  egressSemantic: z.boolean().optional(),
  actionThreshold: z.number().min(0).max(1).optional(),
  reviewThreshold: z.number().min(0).max(1).optional(),
  gates: z.record(z.string(), z.boolean()).optional(),
})

export type RuntimeOverrides = z.infer<typeof RuntimeOverridesSchema>

const OverridesFileSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  note: z.string().optional(),
  expiresOn: z.enum(["pass", "manual"]),
  overrides: RuntimeOverridesSchema,
})

export type OverridesFile = z.infer<typeof OverridesFileSchema>

export function overridesFilePath(config: Config, root: string): string {
  return join(expandPath(config.cache.dir, root), OVERRIDES_FILENAME)
}

export function readRuntimeOverridesFile(config: Config, root: string): OverridesFile | null {
  const path = overridesFilePath(config, root)
  if (!existsSync(path)) return null
  try {
    const parsed = OverridesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

export function writeRuntimeOverridesFile(config: Config, root: string, file: OverridesFile): void {
  const path = overridesFilePath(config, root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + ".tmp"
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}

export function clearRuntimeOverrides(config: Config, root: string): boolean {
  const path = overridesFilePath(config, root)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export function applyRuntimeOverrides(config: Config, overrides: RuntimeOverrides): { config: Config; appliedGates: string[] } {
  const next = structuredClone(config)
  const appliedGates: string[] = []
  if (overrides.activePolicy !== undefined) {
    if (!(overrides.activePolicy in next.policies)) {
      throw new Error(`runtime override activePolicy '${overrides.activePolicy}' is not a defined policy`)
    }
    next.activePolicy = overrides.activePolicy
  }
  if (overrides.egressSemantic !== undefined) next.egress.semantic = overrides.egressSemantic
  if (overrides.actionThreshold !== undefined || overrides.reviewThreshold !== undefined) {
    const policy = next.policies[next.activePolicy]
    if (!policy) throw new Error(`activePolicy '${next.activePolicy}' not defined in policies`)
    next.policies[next.activePolicy] = {
      actionThreshold: overrides.actionThreshold ?? policy.actionThreshold,
      reviewThreshold: overrides.reviewThreshold ?? policy.reviewThreshold,
    }
  }
  for (const [name, value] of Object.entries(overrides.gates ?? {})) {
    appliedGates.push(...applyGateFlag(next, name, value))
  }
  return { config: next, appliedGates }
}

export function applyRuntimeOverridesFromDisk(config: Config, root: string): { config: Config; overrides: RuntimeOverrides | null } {
  const file = readRuntimeOverridesFile(config, root)
  if (!file) return { config, overrides: null }
  try {
    return { config: applyRuntimeOverrides(config, file.overrides).config, overrides: file.overrides }
  } catch {
    return { config, overrides: null }
  }
}
