/**
 * config-models.ts — opencode.json model entries as an additional free signal.
 *
 * The runtime's model catalog (V2 `ctx.model.list()` / V1 SDK) is the primary
 * source of model information. This module contributes the user's own
 * `opencode.json` `provider.<id>.models` entries so BOTH sources are inspected
 * together when the primary source is available:
 *
 *   free = primary cost says zero  OR  primary id/name marks free
 *          OR config name/id marks free OR config cost says zero
 *
 * Matching is exact and same-provider only: a primary entry correlates with a
 * config model when both the providerID and the model id agree — either the
 * config `id`/key equals the primary modelID, or the raw config key does.
 * Entries for other providers (or other ids) are never combined.
 *
 * `readConfigModels` is the only I/O here (the global config file); the merge
 * itself is pure and unit-tested. The reader is shared by V1 and V2.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
// Imported with an explicit .ts extension so plain Node (type stripping) can
// run the unit tests; Bun/OpenCode accept both .ts and .js specifiers.
import { isFreeModel, type ModelEntry } from "./listing.ts"

export type ConfigModel = {
  providerID: string
  /** config `id` when present, else the model key */
  modelID: string
  /** the raw key in `provider.<id>.models` */
  key: string
  name?: string
  family?: string
  context?: number
  releaseDate?: string
  cost?: unknown
}

/** Read custom provider models from `opencode.json` (global config by default). */
export async function readConfigModels(configPath?: string): Promise<ConfigModel[]> {
  const path = configPath ?? join(homedir(), ".config", "opencode", "opencode.json")
  try {
    const raw = await readFile(path, "utf-8")
    const cfg = JSON.parse(raw) as {
      provider?: Record<
        string,
        {
          models?: Record<
            string,
            { id?: string; name?: string; family?: string; limit?: { context?: number }; release_date?: string; cost?: unknown }
          >
        }
      >
    }
    const out: ConfigModel[] = []
    for (const [providerID, p] of Object.entries(cfg.provider ?? {})) {
      for (const [key, m] of Object.entries(p.models ?? {})) {
        out.push({
          providerID,
          modelID: m?.id ?? key,
          key,
          name: m?.name,
          family: m?.family,
          context: m?.limit?.context,
          releaseDate: m?.release_date,
          cost: m?.cost,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Merge config signals into primary entries (same provider + same model id or
 * config key). Returns new entries; the input is not mutated. Config models
 * with no primary counterpart are appended so config-only providers stay
 * visible even when the primary source skipped them.
 */
export function mergeConfigModels(entries: readonly ModelEntry[], configs: readonly ConfigModel[]): ModelEntry[] {
  if (configs.length === 0) return entries.slice()
  const out: ModelEntry[] = []
  const matched = new Set<ConfigModel>()
  for (const entry of entries) {
    const hit = configs.find(
      (c) => c.providerID === entry.providerID && (c.modelID === entry.modelID || c.key === entry.modelID),
    )
    if (!hit) {
      out.push(entry)
      continue
    }
    matched.add(hit)
    out.push({
      ...entry,
      free: Boolean(entry.free) || isFreeModel(hit.modelID, hit.name, hit.cost),
      name: entry.name || hit.name || entry.modelID,
      family: entry.family ?? hit.family,
      context: entry.context ?? hit.context,
      releaseDate: entry.releaseDate ?? hit.releaseDate,
    })
  }
  for (const c of configs) {
    if (matched.has(c)) continue
    out.push({
      providerID: c.providerID,
      modelID: c.modelID,
      qualified: `${c.providerID}/${c.modelID}`,
      name: c.name ?? c.modelID,
      family: c.family,
      context: c.context,
      releaseDate: c.releaseDate,
      free: isFreeModel(c.modelID, c.name, c.cost),
      _raw: c,
    })
  }
  return out
}
