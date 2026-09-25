/**
 * resolver.ts — Resolve `model` input to (providerID, modelID) identity.
 *
 * Rules (per V1 spec):
 *  - If input contains "/", split on first "/" → exact provider/model lookup.
 *  - Else fuzzy search registry. 0 → NotFound, 1 → Resolved, 2+ → Ambiguous
 *    unless `preferredProviders` makes it deterministic.
 *  - Never infer from price. Never guess.
 */

import type { ModelEntry } from "./registry.js";
import type { Registry } from "./registry.js";

export type Resolved = { kind: "resolved"; entry: ModelEntry; viaPreferred?: boolean };
export type Ambiguous = { kind: "ambiguous"; input: string; matches: ModelEntry[] };
export type NotFound = { kind: "not_found"; input: string; suggestion?: string };
export type ResolveResult = Resolved | Ambiguous | NotFound;

export type ResolverConfig = {
  preferredProviders?: Record<string, string>;
};

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_.\s]/g, "");
}

export class Resolver {
  constructor(
    private registry: Registry,
    private config: ResolverConfig = {},
  ) {}

  /**
   * Resolve free-form model string.
   * `modelInput` examples: "gemini 3.7", "gemini-3.7-flash", "google/gemini-2.5-flash",
   * "openrouter/google/gemini-3.7" (provider=openrouter, modelID=google/gemini-3.7)
   */
  resolve(modelInput: string): ResolveResult {
    const raw = modelInput.trim();
    if (!raw) return { kind: "not_found", input: modelInput, suggestion: "model string empty" };

    // Qualified form: contains "/"
    const slash = raw.indexOf("/");
    if (slash > 0) {
      const providerID = raw.slice(0, slash).trim();
      const modelID = raw.slice(slash + 1).trim();
      if (!providerID || !modelID) {
        return { kind: "not_found", input: modelInput, suggestion: `invalid qualified form "${raw}" — expect provider/model` };
      }
      const exact = this.registry.findExact(providerID, modelID);
      if (exact) return { kind: "resolved", entry: exact };
      // try case-insensitive fallback for provider (keep modelID case-sensitive for e.g. Qwen caps)
      const ciProvider = this.registry.all().find((e) => e.providerID.toLowerCase() === providerID.toLowerCase() && e.modelID === modelID);
      if (ciProvider) return { kind: "resolved", entry: ciProvider };
      return {
        kind: "not_found",
        input: modelInput,
        suggestion: `no exact match for "${providerID}/${modelID}". Try discover_models("${modelID.split("/").pop() ?? modelID}")`,
      };
    }

    // Short-name fuzzy
    const { models: candidates, total } = this.registry.search(raw, 50);
    if (total === 0 || candidates.length === 0) {
      return { kind: "not_found", input: modelInput, suggestion: `no match for "${raw}". Try discover_models("${raw}")` };
    }

    // If any candidate is an exact id match, narrow to only exact matches.
    // This prevents "gemini-2.5-flash" from being ambiguous with "gemini-2.5-flash-lite/image" variants.
    const rawNorm = normalizeKey(raw);
    const hasExact = candidates.some((c) => normalizeKey(c.modelID) === rawNorm);
    const matches = hasExact ? candidates.filter((c) => normalizeKey(c.modelID) === rawNorm) : candidates;

    if (matches.length === 1) {
      return { kind: "resolved", entry: matches[0] };
    }
    if (matches.length === 0) {
      // fallback — shouldn't happen, but keep candidates
      return { kind: "not_found", input: modelInput, suggestion: `no match for "${raw}". Try discover_models("${raw}")` };
    }

    // 2+ → try preferredProviders tie-breaker
    const pref = this.tryPreferred(raw, matches);
    if (pref) return { kind: "resolved", entry: pref, viaPreferred: true };

    // Still ambiguous
    return { kind: "ambiguous", input: modelInput, matches: matches.slice(0, 10) };
  }

  private tryPreferred(raw: string, matches: ModelEntry[]): ModelEntry | null {
    const pp = this.config.preferredProviders;
    if (!pp || Object.keys(pp).length === 0) return null;

    const rawNorm = normalizeKey(raw);
    for (const [key, providerID] of Object.entries(pp)) {
      const keyNorm = normalizeKey(key);
      const keyMatchesRaw = rawNorm.includes(keyNorm) || keyNorm.includes(rawNorm);
      if (!keyMatchesRaw) continue;
      const fromProvider = matches.filter((m) => m.providerID.toLowerCase() === providerID.toLowerCase());
      // Only auto-resolve if exactly one candidate from preferred provider — otherwise remain ambiguous (determinism requires uniqueness)
      if (fromProvider.length === 1) return fromProvider[0];
      if (fromProvider.length > 1) return null;
    }

    // Also try family-based: if raw maps to family via pp key = family name
    for (const m of matches) {
      if (!m.family) continue;
      const famNorm = normalizeKey(m.family);
      for (const [key, providerID] of Object.entries(pp)) {
        if (famNorm === normalizeKey(key) && m.providerID.toLowerCase() === providerID.toLowerCase()) {
          const same = matches.filter((x) => normalizeKey(x.family ?? "") === famNorm && x.providerID.toLowerCase() === providerID.toLowerCase());
          if (same.length === 1) return m;
        }
      }
    }
    return null;
  }
}

export function formatAmbiguous(r: Ambiguous): string {
  const lines = r.matches.map((m) => `  - ${m.qualified}  (${m.name})`).join("\n");
  return [
    `Multiple providers offer "${r.input}" — ${r.matches.length} matches:`,
    lines,
    `Show these matches to the user, ask which one to use, then retry with that exact qualified id.`,
  ].join("\n");
}

export function formatNotFound(r: NotFound): string {
  return `No model matched "${r.input}". ${r.suggestion ?? ""}`.trim() + `\nTry discover_models("${r.input}") to see available options.`;
}
