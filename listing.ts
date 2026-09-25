/**
 * listing.ts — shared, dependency-free helpers for discover_models output.
 *
 * Both implementations render listings through this module so V1 and V2 output
 * cannot drift:
 *   - v1.ts (OpenCode 1.x plugin API) reaches it via registry.ts
 *   - v2.ts (OpenCode 2.x plugin API) uses it directly
 *
 * Pure logic only — no plugin APIs, no I/O. Runtime surfaces stay in the
 * runtime-specific files; this module owns the entry shape, free detection,
 * and rendering conventions.
 *
 * Invariant preserved: no prices are surfaced. `free` is a boolean derived
 * from the provider's zero-cost tiers (or a `-free` id/name) — nothing else
 * from cost data is exposed.
 */

export type ModelEntry = {
  providerID: string
  modelID: string
  /** qualified "provider/model" identity */
  qualified: string
  name: string
  family?: string
  context?: number
  releaseDate?: string
  /** provider reports zero-cost tiers for this model (or the id/name marks it free) */
  free?: boolean
  /** raw source record (SDK/config model object) — never surfaced to the LLM */
  _raw?: unknown
}

/**
 * Free iff every reported cost tier is zero, or the id/name marks a free tier.
 * Providers that report no cost data at all fall back to the naming convention.
 */
export function isFreeModel(modelID: string, name: string | undefined, cost: unknown): boolean {
  const tiers = Array.isArray(cost) ? cost : []
  const zeroCost =
    tiers.length > 0 &&
    tiers.every((t: any) => (Number(t?.input) || 0) === 0 && (Number(t?.output) || 0) === 0)
  return zeroCost || /-free$/i.test(modelID) || /\bfree\b/i.test(String(name ?? ""))
}

/** Other providers offering the same model id. */
function siblingsFor(entry: ModelEntry, all: readonly ModelEntry[]): ModelEntry[] {
  return all.filter((e) => e.modelID === entry.modelID && e.providerID !== entry.providerID)
}

/**
 * Standard search results: one line per model.
 * Marks free models and annotates other providers offering the same model
 * (free siblings are marked so a cheaper provider is visible at a glance).
 */
export function renderSearchResults(
  models: readonly ModelEntry[],
  all: readonly ModelEntry[],
  total: number,
  query: string,
): string {
  const lines = models
    .map((m) => {
      const fam = m.family ? ` family:${m.family}` : ""
      const ctx = m.context ? ` ctx:${m.context}` : ""
      const free = m.free ? " · free" : ""
      const siblings = siblingsFor(m, all)
      let also = ""
      if (siblings.length > 0) {
        const shown = siblings.slice(0, 4).map((s) => (s.free ? `${s.providerID} (free)` : s.providerID))
        also = ` · also: ${shown.join(", ")}${siblings.length > 4 ? ` +${siblings.length - 4}` : ""}`
      }
      return `- ${m.qualified} — ${m.name}${fam}${ctx}${free}${also}`
    })
    .join("\n")
  const header = `Found ${models.length} of ${total} matching "${query || "*"}":`
  const footer = total > models.length ? `(showing top ${models.length} — refine query to narrow)` : ""
  return [header, lines, footer, `Use delegate(model="provider/model", task="...") with one of the above qualified ids.`]
    .filter(Boolean)
    .join("\n")
}

/**
 * Free-model listing, grouped by provider so rate-limit / reliability
 * trade-offs between providers stay visible.
 */
export function renderFreeResults(models: readonly ModelEntry[], total: number, query: string): string {
  const byProvider = new Map<string, ModelEntry[]>()
  for (const m of models) {
    const list = byProvider.get(m.providerID) ?? []
    list.push(m)
    byProvider.set(m.providerID, list)
  }
  const providers = [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const perProvider = 6
  const lines = providers
    .map(([pid, entries]) => {
      const ids = entries.slice(0, perProvider).map((e) => e.modelID)
      return `- ${pid} (${entries.length}): ${ids.join(", ")}${entries.length > perProvider ? ", …" : ""}`
    })
    .join("\n")
  const header = query
    ? `Free models matching "${query}" — ${models.length} across ${providers.length} providers:`
    : `Free models — ${total} across ${providers.length} providers:`
  return [
    header,
    lines,
    `Route with delegate(model="provider/model", task="..."). Free tiers differ in rate limits — *-free (OpenCode Zen) is the most generous; Nvidia's free tier is heavily rate-limited.`,
  ].join("\n")
}
