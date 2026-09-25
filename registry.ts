/**
 * registry.ts — Model catalog abstraction.
 *
 * Sources the live catalog from OpenCode SDK (merges opencode.json + auth.json + zen gateway).
 * Never exposes pricing. Caps results to keep LLM context lean.
 */

import type { createOpencodeClient } from "@opencode-ai/sdk";
import { isFreeModel, type ModelEntry } from "./listing.js";
import { mergeConfigModels, readConfigModels, type ConfigModel } from "./config-models.js";

// The entry shape and the discover_models renderers live in the shared,
// dependency-free listing.ts so V1 and V2 output cannot drift.
// Intentionally no `cost` is surfaced — only a boolean `free`.
export type { ModelEntry };

type RegistryDeps = {
  client: ReturnType<typeof createOpencodeClient>;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_.\s.]/g, "");
}

function scoreMatch(queryNorm: string, entry: ModelEntry): number {
  const idN = normalize(entry.modelID);
  const nameN = normalize(entry.name);
  const famN = normalize(entry.family ?? "");
  const qualN = normalize(entry.qualified);

  // Priority: exact id/qualified -> prefix id -> family exact -> substring
  // Family exact should NOT outrank id prefix, otherwise "gemini" returns embeddings before 2.5-flash.
  if (idN === queryNorm) return 0;
  if (qualN === queryNorm) return 1;
  if (idN.startsWith(queryNorm)) return 10 + (idN.length - queryNorm.length) * 0.01;
  if (nameN.startsWith(queryNorm)) return 11;
  if (famN && famN === queryNorm) return 12;
  if (idN.includes(queryNorm)) return 20;
  if (nameN.includes(queryNorm)) return 21;
  if (famN.includes(queryNorm)) return 22;
  if (qualN.includes(queryNorm)) return 23;
  return 999;
}

export class Registry {
  private entries: ModelEntry[] = [];
  private loadedAt = 0;
  private loading: Promise<ModelEntry[]> | null = null;
  private ttlMs: number;

  constructor(
    private deps: RegistryDeps,
    opts?: { ttlMs?: number },
  ) {
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000;
  }

  private async fetchFromSdk(): Promise<ModelEntry[]> {
    // SDK merged catalog — source of truth: opencode.json + auth.json + zen gateway + provider hooks
    // Try both endpoints because SDK versioning exposes them under different namespaces.
    let providers: Array<{
      id: string;
      models: Record<string, { id?: string; name?: string; family?: string; limit?: { context?: number }; release_date?: string }>;
    }> = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = this.deps.client as any;
      // v2: client.config.providers() → { providers: Provider[], default }
      if (c.config?.providers) {
        try {
          const res = await c.config.providers();
          const d = (res as { data?: unknown })?.data as
            | { providers?: typeof providers; all?: typeof providers }
            | typeof providers
            | undefined;
          if (d && typeof d === "object" && "providers" in (d as object) && Array.isArray((d as { providers?: unknown }).providers))
            providers = (d as { providers: typeof providers }).providers;
          else if (d && typeof d === "object" && "all" in (d as object) && Array.isArray((d as { all?: unknown }).all))
            providers = (d as { all: typeof providers }).all;
          else if (Array.isArray(d)) providers = d as typeof providers;
        } catch {
          // try next
        }
      }
      // fallback/alternative: client.provider.list() → { all, connected, default }
      if (providers.length === 0 && c.provider?.list) {
        try {
          const res = await c.provider.list();
          const d = (res as { data?: unknown })?.data as
            | { providers?: typeof providers; all?: typeof providers }
            | typeof providers
            | undefined;
          if (d && typeof d === "object" && "providers" in (d as object) && Array.isArray((d as { providers?: unknown }).providers))
            providers = (d as { providers: typeof providers }).providers;
          else if (d && typeof d === "object" && "all" in (d as object) && Array.isArray((d as { all?: unknown }).all))
            providers = (d as { all: typeof providers }).all;
          else if (Array.isArray(d)) providers = d as typeof providers;
        } catch {
          // fall through
        }
      }
      // legacy SDK shape: client.provider.list directly under provider
      if (providers.length === 0 && c.provider?.all) {
        try {
          const res = await c.provider.all();
          const d = res as unknown as { data?: unknown };
          if (Array.isArray((d as { data?: unknown })?.data)) providers = (d.data as typeof providers);
        } catch {}
      }
    } catch {
      // fall through to empty
    }

    const out: ModelEntry[] = [];
    for (const p of providers) {
      if (!p || !p.id || !p.models) continue;
      for (const [modelKey, m] of Object.entries(p.models)) {
        const modelID = (m as { id?: string }).id ?? modelKey;
        out.push({
          providerID: p.id,
          modelID,
          qualified: `${p.id}/${modelID}`,
          name: (m as { name?: string }).name ?? modelID,
          family: (m as { family?: string }).family,
          context: (m as { limit?: { context?: number } }).limit?.context,
          releaseDate: (m as { release_date?: string }).release_date,
          free: isFreeModel(modelID, (m as { name?: string }).name ?? modelID, (m as { cost?: unknown }).cost),
          _raw: m,
        });
      }
    }
    out.sort((a, b) => a.qualified.localeCompare(b.qualified));
    return out;
  }

  /**
   * Fallback: read directly from filesystem — merges opencode.json + auth.json + models cache.
   * Used when SDK is unavailable (boot timing) or returns suspiciously few models.
   * Filters models cache to only providers that are actually authenticated/configured,
   * so discover_models doesn't flood with 207 unavailable providers.
   */
  private async fetchFromFilesystem(): Promise<ModelEntry[]> {
    const out: ModelEntry[] = [];
    const seen = new Set<string>();

    // 1) opencode.json provider.models (always authoritative for custom providers like bailian, mimo)
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const cfgPath = join(homedir(), ".config", "opencode", "opencode.json");
      const raw = await readFile(cfgPath, "utf-8");
      const cfg = JSON.parse(raw) as {
        provider?: Record<string, { models?: Record<string, { name?: string; family?: string; limit?: { context?: number }; release_date?: string }> }>;
      };
      for (const [providerID, p] of Object.entries(cfg.provider ?? {})) {
        for (const [modelKey, m] of Object.entries(p.models ?? {})) {
          const modelID = (m as { id?: string })?.id ?? modelKey;
          const qualified = `${providerID}/${modelID}`;
          if (seen.has(qualified)) continue;
          seen.add(qualified);
          out.push({
            providerID,
            modelID,
            qualified,
            name: (m as { name?: string })?.name ?? modelID,
            family: (m as { family?: string })?.family,
            context: (m as { limit?: { context?: number } })?.limit?.context,
            releaseDate: (m as { release_date?: string })?.release_date,
            free: isFreeModel(modelID, (m as { name?: string })?.name ?? modelID, (m as { cost?: unknown })?.cost),
            _raw: m,
          });
        }
      }
    } catch {
      // non-fatal
    }

    // 2) auth.json + models cache filtered to connected providers
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
      const cachePath = join(homedir(), ".cache", "opencode", "models.json");
      const [authRaw, cacheRaw] = await Promise.all([
        readFile(authPath, "utf-8").catch(() => "{}"),
        readFile(cachePath, "utf-8").catch(() => "{}"),
      ]);
      const auth = JSON.parse(authRaw) as Record<string, unknown>;
      const cache = JSON.parse(cacheRaw) as Record<
        string,
        { models?: Record<string, { id?: string; name?: string; family?: string; limit?: { context?: number }; release_date?: string }> }
      >;
      const connectedProviders = new Set(Object.keys(auth));
      // opencode and opencode-go are always considered "connected" if cache has them, even if auth missing? but we already filter by auth
      for (const providerID of connectedProviders) {
        const entry = cache[providerID];
        if (!entry?.models) continue;
        for (const [modelKey, m] of Object.entries(entry.models)) {
          const modelID = (m as { id?: string })?.id ?? modelKey;
          const qualified = `${providerID}/${modelID}`;
          if (seen.has(qualified)) continue;
          seen.add(qualified);
          out.push({
            providerID,
            modelID,
            qualified,
            name: (m as { name?: string })?.name ?? modelID,
            family: (m as { family?: string })?.family,
            context: (m as { limit?: { context?: number } })?.limit?.context,
            releaseDate: (m as { release_date?: string })?.release_date,
            free: isFreeModel(modelID, (m as { name?: string })?.name ?? modelID, (m as { cost?: unknown })?.cost),
            _raw: m,
          });
        }
      }
    } catch {
      // non-fatal
    }

    out.sort((a, b) => a.qualified.localeCompare(b.qualified));
    return out;
  }

  private async fetchMerged(): Promise<ModelEntry[]> {
    const [fromSdk, fromFs, configs] = await Promise.all([
      this.fetchFromSdk().catch(() => [] as ModelEntry[]),
      this.fetchFromFilesystem().catch(() => [] as ModelEntry[]),
      readConfigModels().catch(() => [] as ConfigModel[]),
    ]);
    // Both sources are inspected together: enrich SDK entries with config
    // signals (same provider + same id) and keep config-only models visible.
    // The filesystem merge below is only for entries neither source produced.
    if (fromSdk.length === 0) return fromFs;
    const enriched = mergeConfigModels(fromSdk, configs);
    const byQualified = new Map<string, ModelEntry>();
    for (const e of enriched) byQualified.set(e.qualified, e);
    for (const e of fromFs) {
      if (!byQualified.has(e.qualified)) byQualified.set(e.qualified, e);
    }
    const merged = Array.from(byQualified.values());
    merged.sort((a, b) => a.qualified.localeCompare(b.qualified));
    return merged;
  }

  async load(opts?: { force?: boolean }): Promise<ModelEntry[]> {
    const now = Date.now();
    if (!opts?.force && this.entries.length > 0 && now - this.loadedAt < this.ttlMs) {
      return this.entries;
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const fetched = await this.fetchMerged();
        if (fetched.length > 0) {
          this.entries = fetched;
          this.loadedAt = Date.now();
        }
        return this.entries;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** All entries (cached, may be stale). Call load() first if freshness matters. */
  all(): ModelEntry[] {
    return this.entries.slice();
  }

  /**
   * Search with optional query. Caps to `limit` (default 20).
   * Returns sorted by relevance (exact → prefix → substring).
   */
  search(query?: string, limit = 20, opts?: { freeOnly?: boolean }): { models: ModelEntry[]; total: number } {
    const all = opts?.freeOnly ? this.entries.filter((e) => e.free) : this.entries;
    if (!query || !query.trim()) {
      return { models: all.slice(0, limit), total: all.length };
    }
    const qNorm = normalize(query.trim());
    const scored = all
      .map((e) => ({ e, s: scoreMatch(qNorm, e) }))
      .filter(({ s }) => s < 999)
      .sort((a, b) => {
        if (a.s !== b.s) return a.s - b.s;
        // tie-breaker: prefer more recent release, then larger context, then lexicographic
        const aDate = a.e.releaseDate ?? "";
        const bDate = b.e.releaseDate ?? "";
        if (aDate !== bDate) return bDate.localeCompare(aDate);
        const aCtx = a.e.context ?? 0;
        const bCtx = b.e.context ?? 0;
        if (aCtx !== bCtx) return bCtx - aCtx;
        return a.e.qualified.localeCompare(b.e.qualified);
      })
      .map(({ e }) => e);
    return { models: scored.slice(0, limit), total: scored.length };
  }

  /** Exact lookup by providerID + modelID */
  findExact(providerID: string, modelID: string): ModelEntry | undefined {
    return this.entries.find((e) => e.providerID === providerID && e.modelID === modelID);
  }

  /** Force refresh next call */
  invalidate(): void {
    this.loadedAt = 0;
  }
}
