/**
 * v2.ts — V2 implementation (OpenCode 2.x plugin API), self-contained.
 *
 * The V1 implementation lives in v1.ts; index.ts exposes both from one default
 * export (OpenCode 2.x calls setup(), OpenCode 1.18.29+ calls server()).
 *
 * V2 adaptations:
 *   - default export `{ id, setup }` (V1 named/functional exports are rejected by V2)
 *   - tools registered via ctx.tool.transform(editor => editor.add(...)) with JSON Schema inputs
 *   - system hint injected via ctx.session.hook("context") (was experimental.chat.system.transform)
 *   - model catalog from ctx.model.list() with filesystem fallback
 *     (opencode.json provider.models + auth.json + models.json) — same merge heuristic as V1
 *   - execution: session.create (parentID best-effort) -> session.prompt -> session.wait
 *     -> session.context; abort signal wired to session.interrupt
 *   - V1 ctx.metadata() live Task-pane publishing dropped; child ids returned in ToolResult metadata
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isFreeModel, renderFreeResults, renderSearchResults, type ModelEntry } from "./listing.js"

/* ------------------------------------------------------------------ options */

type PluginOptions = {
  preferredProviders?: Record<string, string>
  registryTtlMs?: number
  hintInSystemPrompt?: boolean
}

function readOptions(ctx: any): PluginOptions {
  const raw = (ctx?.options ?? {}) as Record<string, unknown>
  const nested = (raw["opencode-subagent-delegate"] ?? raw["model-router"]) as PluginOptions | undefined
  const opts = nested && typeof nested === "object" ? nested : (raw as PluginOptions)
  return {
    preferredProviders: opts.preferredProviders ?? {},
    registryTtlMs: opts.registryTtlMs ?? 5 * 60 * 1000,
    hintInSystemPrompt: opts.hintInSystemPrompt ?? true,
  }
}

/* -------------------------------------------------------------------- hint */

// Small system hint — no catalog inside; discovery happens through discover_models().
const SYSTEM_HINT = [
  "## Subagent delegation — opencode-subagent-delegate",
  "Run subagents on any connected model; each run appears as a clickable inline Task pane. Use them when they add value (parallel work, isolation, second opinions); skip trivial single-step replies.",
  "Tools:",
  "- `task(description, prompt, subagent_type?, model?, variant?)` — preferred; omit `model` to inherit this session's model.",
  "- `delegate(model, task, agent?, variant?)` — explicit; a model is required.",
  "- `discover_models(query?)` — exact ids when unsure (substring over id/name/family, ≤20 rows, no prices).",
  "Routing policy:",
  "- No model requested → call task WITHOUT `model`; the subagent inherits the current model. Never route to another model on your own.",
  '- A model class is requested (free / cheap / fast / strong / local) → discover_models first; for free call discover_models(free=true) — zero-cost models per provider (Zen *-free, Nvidia, plan-included); prefer *-free for the most generous limits (Nvidia is rate-limited).',
  "- A specific model is named → resolve it; if the same model exists on several providers (or the id is ambiguous), show the matches and ask the USER which one to use — never choose a provider yourself. Route to their choice; on an unknown id, discover_models first.",
  "Pick models you know exist; never guess from price. Keep `description` to 3-5 words.",
].join("\n")

/* ----------------------------------------------------------------- registry */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_.\s.]/g, "")
}

function scoreMatch(queryNorm: string, entry: ModelEntry): number {
  const idN = normalize(entry.modelID)
  const nameN = normalize(entry.name)
  const famN = normalize(entry.family ?? "")
  const qualN = normalize(entry.qualified)

  // Family exact should NOT outrank id prefix, otherwise "gemini" returns embeddings before 2.5-flash.
  if (idN === queryNorm) return 0
  if (qualN === queryNorm) return 1
  if (idN.startsWith(queryNorm)) return 10 + (idN.length - queryNorm.length) * 0.01
  if (nameN.startsWith(queryNorm)) return 11
  if (famN && famN === queryNorm) return 12
  if (idN.includes(queryNorm)) return 20
  if (nameN.includes(queryNorm)) return 21
  if (famN.includes(queryNorm)) return 22
  if (qualN.includes(queryNorm)) return 23
  return 999
}

class Registry {
  private entries: ModelEntry[] = []
  private loadedAt = 0
  private loading: Promise<ModelEntry[]> | null = null

  constructor(private ctx: any, private ttlMs: number = 5 * 60 * 1000) {}

  /** Primary source: live merged catalog served by ctx.model.list(). */
  private async fetchFromApi(): Promise<ModelEntry[]> {
    try {
      const res = await this.ctx.model.list()
      const data: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
      const out: ModelEntry[] = []
      for (const m of data) {
        if (!m || m.enabled === false) continue
        const providerID = String(m.providerID ?? "")
        const modelID = String(m.modelID ?? m.id ?? "")
        if (!providerID || !modelID) continue
        out.push({
          providerID,
          modelID,
          qualified: `${providerID}/${modelID}`,
          name: typeof m.name === "string" && m.name ? m.name : modelID,
          family: m.family,
          context: m.limit?.context,
          releaseDate: typeof m.time?.released === "number" ? new Date(m.time.released).toISOString() : undefined,
          free: isFreeModel(modelID, typeof m.name === "string" ? m.name : modelID, m.cost),
        })
      }
      return out
    } catch {
      return []
    }
  }

  /** Fallback: read from filesystem — merges opencode.json + auth.json + models cache. */
  private async fetchFromFilesystem(): Promise<ModelEntry[]> {
    const out: ModelEntry[] = []
    const seen = new Set<string>()

    // 1) opencode.json provider.models (authoritative for custom providers like bailian/mimo)
    try {
      const cfgPath = join(homedir(), ".config", "opencode", "opencode.json")
      const cfg = JSON.parse(await readFile(cfgPath, "utf-8")) as {
        provider?: Record<string, { models?: Record<string, { id?: string; name?: string; family?: string; limit?: { context?: number }; release_date?: string }> }>
      }
      for (const [providerID, p] of Object.entries(cfg.provider ?? {})) {
        for (const [modelKey, m] of Object.entries(p.models ?? {})) {
          const modelID = m?.id ?? modelKey
          const qualified = `${providerID}/${modelID}`
          if (seen.has(qualified)) continue
          seen.add(qualified)
          out.push({
            providerID,
            modelID,
            qualified,
            name: m?.name ?? modelID,
            family: m?.family,
            context: m?.limit?.context,
            releaseDate: m?.release_date,
            free: isFreeModel(modelID, m?.name ?? modelID, (m as { cost?: unknown })?.cost),
          })
        }
      }
    } catch {
      // non-fatal
    }

    // 2) auth.json + models cache filtered to authenticated providers
    try {
      const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
      const cachePath = join(homedir(), ".cache", "opencode", "models.json")
      const [authRaw, cacheRaw] = await Promise.all([
        readFile(authPath, "utf-8").catch(() => "{}"),
        readFile(cachePath, "utf-8").catch(() => "{}"),
      ])
      const auth = JSON.parse(authRaw) as Record<string, unknown>
      const cache = JSON.parse(cacheRaw) as Record<
        string,
        { models?: Record<string, { id?: string; name?: string; family?: string; limit?: { context?: number }; release_date?: string }> }
      >
      for (const providerID of Object.keys(auth)) {
        const entry = cache[providerID]
        if (!entry?.models) continue
        for (const [modelKey, m] of Object.entries(entry.models)) {
          const modelID = m?.id ?? modelKey
          const qualified = `${providerID}/${modelID}`
          if (seen.has(qualified)) continue
          seen.add(qualified)
          out.push({
            providerID,
            modelID,
            qualified,
            name: m?.name ?? modelID,
            family: m?.family,
            context: m?.limit?.context,
            releaseDate: m?.release_date,
            free: isFreeModel(modelID, m?.name ?? modelID, (m as { cost?: unknown })?.cost),
          })
        }
      }
    } catch {
      // non-fatal
    }

    out.sort((a, b) => a.qualified.localeCompare(b.qualified))
    return out
  }

  private async fetchMerged(): Promise<ModelEntry[]> {
    const [fromApi, fromFs] = await Promise.all([
      this.fetchFromApi().catch(() => [] as ModelEntry[]),
      this.fetchFromFilesystem().catch(() => [] as ModelEntry[]),
    ])
    if (fromApi.length === 0) return fromFs
    const byQualified = new Map<string, ModelEntry>()
    for (const e of fromApi) byQualified.set(e.qualified, e)
    for (const e of fromFs) {
      if (!byQualified.has(e.qualified)) byQualified.set(e.qualified, e)
    }
    const merged = Array.from(byQualified.values())
    merged.sort((a, b) => a.qualified.localeCompare(b.qualified))
    // API gave suspiciously few (<20) but FS gave many more → prefer merged (boot race)
    if (fromApi.length < 20 && merged.length > fromApi.length * 2) return merged
    return merged
  }

  async load(opts?: { force?: boolean }): Promise<ModelEntry[]> {
    const now = Date.now()
    if (!opts?.force && this.entries.length > 0 && now - this.loadedAt < this.ttlMs) {
      return this.entries
    }
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const fetched = await this.fetchMerged()
        if (fetched.length > 0) {
          this.entries = fetched
          this.loadedAt = Date.now()
        }
        return this.entries
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  /** All entries (cached, may be stale). Call load() first if freshness matters. */
  all(): ModelEntry[] {
    return this.entries.slice()
  }

  /** Search with optional query. Caps to `limit` (default 20), sorted by relevance. */
  search(query?: string, limit = 20, opts?: { freeOnly?: boolean }): { models: ModelEntry[]; total: number } {
    const all = opts?.freeOnly ? this.entries.filter((e) => e.free) : this.entries
    if (!query || !query.trim()) {
      return { models: all.slice(0, limit), total: all.length }
    }
    const qNorm = normalize(query.trim())
    const scored = all
      .map((e) => ({ e, s: scoreMatch(qNorm, e) }))
      .filter(({ s }) => s < 999)
      .sort((a, b) => {
        if (a.s !== b.s) return a.s - b.s
        const aDate = a.e.releaseDate ?? ""
        const bDate = b.e.releaseDate ?? ""
        if (aDate !== bDate) return bDate.localeCompare(aDate)
        const aCtx = a.e.context ?? 0
        const bCtx = b.e.context ?? 0
        if (aCtx !== bCtx) return bCtx - aCtx
        return a.e.qualified.localeCompare(b.e.qualified)
      })
      .map(({ e }) => e)
    return { models: scored.slice(0, limit), total: scored.length }
  }

  /** Exact lookup by providerID + modelID */
  findExact(providerID: string, modelID: string): ModelEntry | undefined {
    return this.entries.find((e) => e.providerID === providerID && e.modelID === modelID)
  }

  /** Force refresh next call */
  invalidate(): void {
    this.loadedAt = 0
  }
}

/* ------------------------------------------------------------------ resolver */

type Resolved = { kind: "resolved"; entry: ModelEntry; viaPreferred?: boolean }
type Ambiguous = { kind: "ambiguous"; input: string; matches: ModelEntry[] }
type NotFound = { kind: "not_found"; input: string; suggestion?: string }
type ResolveResult = Resolved | Ambiguous | NotFound

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_.\s]/g, "")
}

class Resolver {
  constructor(
    private registry: Registry,
    private config: { preferredProviders?: Record<string, string> } = {},
  ) {}

  /**
   * Resolve free-form model string.
   * "gemini 3.7" | "gemini-3.7-flash" | "google/gemini-2.5-flash"
   * | "openrouter/google/gemini-3.7" (provider=openrouter, modelID=google/gemini-3.7)
   */
  resolve(modelInput: string): ResolveResult {
    const raw = modelInput.trim()
    if (!raw) return { kind: "not_found", input: modelInput, suggestion: "model string empty" }

    const slash = raw.indexOf("/")
    if (slash > 0) {
      const providerID = raw.slice(0, slash).trim()
      const modelID = raw.slice(slash + 1).trim()
      if (!providerID || !modelID) {
        return { kind: "not_found", input: modelInput, suggestion: `invalid qualified form "${raw}" — expect provider/model` }
      }
      const exact = this.registry.findExact(providerID, modelID)
      if (exact) return { kind: "resolved", entry: exact }
      // case-insensitive fallback for provider (modelID stays case-sensitive, e.g. Qwen caps)
      const ciProvider = this.registry.all().find(
        (e) => e.providerID.toLowerCase() === providerID.toLowerCase() && e.modelID === modelID,
      )
      if (ciProvider) return { kind: "resolved", entry: ciProvider }
      return {
        kind: "not_found",
        input: modelInput,
        suggestion: `no exact match for "${providerID}/${modelID}". Try discover_models("${modelID.split("/").pop() ?? modelID}")`,
      }
    }

    // Short-name fuzzy
    const { models: candidates, total } = this.registry.search(raw, 50)
    if (total === 0 || candidates.length === 0) {
      return { kind: "not_found", input: modelInput, suggestion: `no match for "${raw}". Try discover_models("${raw}")` }
    }

    // Exact id match narrows candidates ("gemini-2.5-flash" vs ".../image" variants).
    const rawNorm = normalizeKey(raw)
    const hasExact = candidates.some((c) => normalizeKey(c.modelID) === rawNorm)
    const matches = hasExact ? candidates.filter((c) => normalizeKey(c.modelID) === rawNorm) : candidates

    if (matches.length === 1) return { kind: "resolved", entry: matches[0] }
    if (matches.length === 0) {
      return { kind: "not_found", input: modelInput, suggestion: `no match for "${raw}". Try discover_models("${raw}")` }
    }

    const pref = this.tryPreferred(raw, matches)
    if (pref) return { kind: "resolved", entry: pref, viaPreferred: true }

    return { kind: "ambiguous", input: modelInput, matches: matches.slice(0, 10) }
  }

  private tryPreferred(raw: string, matches: ModelEntry[]): ModelEntry | null {
    const pp = this.config.preferredProviders
    if (!pp || Object.keys(pp).length === 0) return null

    const rawNorm = normalizeKey(raw)
    for (const [key, providerID] of Object.entries(pp)) {
      const keyNorm = normalizeKey(key)
      const keyMatchesRaw = rawNorm.includes(keyNorm) || keyNorm.includes(rawNorm)
      if (!keyMatchesRaw) continue
      const fromProvider = matches.filter((m) => m.providerID.toLowerCase() === providerID.toLowerCase())
      // Only auto-resolve when exactly one candidate (determinism requires uniqueness)
      if (fromProvider.length === 1) return fromProvider[0]
      if (fromProvider.length > 1) return null
    }

    // Family-based: pp key = family name
    for (const m of matches) {
      if (!m.family) continue
      const famNorm = normalizeKey(m.family)
      for (const [key, providerID] of Object.entries(pp)) {
        if (famNorm === normalizeKey(key) && m.providerID.toLowerCase() === providerID.toLowerCase()) {
          const same = matches.filter(
            (x) => normalizeKey(x.family ?? "") === famNorm && x.providerID.toLowerCase() === providerID.toLowerCase(),
          )
          if (same.length === 1) return m
        }
      }
    }
    return null
  }
}

function formatAmbiguous(r: Ambiguous): string {
  const lines = r.matches.map((m) => `  - ${m.qualified}  (${m.name})`).join("\n")
  return [
    `Multiple providers offer "${r.input}" — ${r.matches.length} matches:`,
    lines,
    `Show these matches to the user, ask which one to use, then retry with that exact qualified id.`,
  ].join("\n")
}

function formatNotFound(r: NotFound): string {
  return (`No model matched "${r.input}". ${r.suggestion ?? ""}`.trim() + `\nTry discover_models("${r.input}") to see available options.`)
}

/* ----------------------------------------------------------------- execution */

type RunCtx = {
  sessionID: string
  messageID?: string
  signal?: any
  /** best-effort progress sink (wired to the tool context's progress()) */
  onProgress?: (message: string) => void
}
type ExecOpts = { agent?: string; variant?: string; title?: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Hard ceiling for a single child run — interrupts the child and reports instead of hanging. */
const WAIT_CEILING_MS = 30 * 60 * 1000

function progressReporter(toolCtx: any): (message: string) => void {
  return (message: string) => {
    try {
      void toolCtx?.progress?.({ status: message })
    } catch {
      // progress is best-effort
    }
  }
}

class SessionExecution {
  constructor(private ctx: any) {}

  async execute(
    entry: ModelEntry | null,
    task: string,
    run: RunCtx,
    opts: ExecOpts = {},
  ): Promise<{ output: string; sessionID: string }> {
    const base: any = {}
    if (opts.title) base.title = opts.title
    else {
      // Derive a title so the child does not need an extra auto-title model call
      // (that call queues on throttled/free providers and delays completion).
      const t = task.replace(/\s+/g, " ").trim()
      if (t) base.title = t.length > 48 ? `${t.slice(0, 45)}…` : t
    }
    if (opts.agent) base.agent = opts.agent
    if (entry) {
      base.model = { providerID: entry.providerID, id: entry.modelID, ...(opts.variant ? { variant: opts.variant } : {}) }
    } else {
      // No model requested → inherit the invoking session's model explicitly
      // (do not rely on runtime defaults for a fresh child session).
      try {
        const parent: any = await this.ctx.session.get({ sessionID: run.sessionID })
        const m: any = parent?.model
        const providerID = m?.providerID
        const modelID = m?.id ?? m?.modelID
        if (providerID && modelID) {
          base.model = { providerID, id: modelID, ...(m.variant ? { variant: m.variant } : {}) }
        }
      } catch {
        // parent session unavailable — fall through to the runtime default
      }
      if (opts.variant) {
        if (base.model) base.model.variant = opts.variant
        else {
          // Variant requested but no session model known — attach it to the default model.
          try {
            const def: any = await this.ctx.model.default?.()
            const info: any = def?.data ?? def
            const providerID = info?.providerID
            const modelID = info?.modelID ?? info?.id
            if (providerID && modelID) base.model = { providerID, id: modelID, variant: opts.variant }
          } catch {
            // default model unavailable — run without variant
          }
        }
      }
    }

    // Parent linkage is not part of V2 SessionCreateInput; send it best-effort and
    // retry without when the server rejects unknown keys.
    let child: any
    try {
      child = await this.ctx.session.create({ ...base, parentID: run.sessionID })
    } catch {
      child = await this.ctx.session.create({ ...base })
    }
    const childID = String(child?.id ?? child?.sessionID ?? "")
    if (!childID) throw new Error("session.create returned no session id")

    // Wire abort -> interrupt so stopping the parent stops the child.
    const signal: AbortSignal | undefined = run.signal
    let aborted = false
    const onAbort = async () => {
      if (aborted) return
      aborted = true
      try {
        await this.ctx.session.interrupt({ sessionID: childID })
      } catch {
        // best-effort
      }
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
    if (signal?.aborted) void onAbort()

    try {
      await this.ctx.session.prompt({ sessionID: childID, text: task })
      await this.waitForCompletion(childID, run, () => aborted)
      if (aborted) return { output: "(delegation interrupted)", sessionID: childID }

      let messages: any[] = []
      try {
        messages = (await this.ctx.session.context({ sessionID: childID })) ?? []
      } catch {
        messages = []
      }

      let text = ""
      let failure = ""
      for (const m of messages) {
        if (m?.error) failure = String(m.error.message ?? JSON.stringify(m.error))
        if (m?.type === "assistant" && Array.isArray(m.content)) {
          const t = m.content
            .filter((p: any) => p?.type === "text")
            .map((p: any) => String(p?.text ?? ""))
            .join("\n")
            .trim()
          if (t) text = t
        }
      }
      if (!text) {
        if (failure) throw new Error(failure)
        return { output: "(subagent finished without text output)", sessionID: childID }
      }
      return { output: text, sessionID: childID }
    } finally {
      signal?.removeEventListener?.("abort", onAbort)
    }
  }

  /**
   * Wait until the child run completes.
   *
   * `session.wait()` is the documented API, but it is event-based, and a run can
   * legitimately stay active for minutes under provider throttling (queued or
   * retried model calls). Race `wait()` against polling `session.get().time.idle`,
   * report progress while waiting, and enforce a hard ceiling so a tool call can
   * never hang forever.
   */
  private async waitForCompletion(sessionID: string, run: RunCtx, isAborted: () => boolean): Promise<void> {
    const started = Date.now()
    const deadline = started + WAIT_CEILING_MS
    let finished = false
    const waiter = this.ctx.session.wait({ sessionID }).then(
      () => {
        finished = true
      },
      () => {
        finished = true
      },
    )
    let lastProgress = started
    while (!finished && Date.now() < deadline) {
      await Promise.race([waiter, sleep(3000)])
      if (finished) break
      if (isAborted()) break
      try {
        const info: any = await this.ctx.session.get({ sessionID })
        const idleAt = info?.time?.idle
        if (typeof idleAt === "number" && idleAt > started) {
          finished = true
          break
        }
      } catch {
        // transient — keep polling
      }
      const now = Date.now()
      if (now - lastProgress >= 10_000) {
        lastProgress = now
        run.onProgress?.(`subagent running ${Math.round((now - started) / 1000)}s`)
      }
    }
    if (finished) return
    // Ceiling hit — stop the child so it does not keep burning tokens.
    try {
      await this.ctx.session.interrupt({ sessionID })
    } catch {
      // best-effort
    }
    if (isAborted()) return
    throw new Error(`child session did not finish within ${Math.round(WAIT_CEILING_MS / 60000)} minutes (interrupted)`)
  }
}

/* --------------------------------------------------------------------- tools */

function errorHint(qualified: string, msg: string, providerID?: string, modelID?: string): string {
  let hint = `Delegate failed: ${msg}`
  const lower = msg.toLowerCase()
  if (msg.includes("ModelUnavailableError") || (lower.includes("model") && lower.includes("unavailable"))) {
    const short = (modelID ?? qualified).split("/").pop() ?? modelID ?? qualified
    hint = `Model "${qualified}" unavailable for this request: ${msg}\nTry another provider for same family, e.g. discover_models("${short}")`
  } else if (lower.includes("auth") || lower.includes("api key")) {
    hint = `Provider auth error for "${qualified}": ${msg}\nCheck ~/.local/share/opencode/auth.json credential for provider "${providerID ?? qualified}".`
  }
  return hint
}

/* ---------------------------------------------------------------------- main */

export default {
  id: "opencode-subagent-delegate",
  async setup(ctx: any) {
    const options = readOptions(ctx)
    const registry = new Registry(ctx, options.registryTtlMs)
    const resolver = new Resolver(registry, { preferredProviders: options.preferredProviders })
    const execution = new SessionExecution(ctx)

    // Shared resolution: force-refresh once on NotFound / ambiguous short names —
    // self-heals stale caches and picks up fresh auth.
    const resolveModel = async (modelInput: string): Promise<ResolveResult> => {
      await registry.load()
      let result = resolver.resolve(modelInput)
      if (result.kind === "not_found" || (result.kind === "ambiguous" && !modelInput.includes("/"))) {
        await registry.load({ force: true })
        const retry = resolver.resolve(modelInput)
        if (retry.kind === "resolved") result = retry
        else if (retry.kind === "ambiguous" && result.kind === "not_found") result = retry
      }
      return result
    }

    // Best-effort eager load — warms cache without blocking startup.
    registry.load().catch(() => {})

    // System hint — only for the agent loop; dedup-guarded.
    if (options.hintInSystemPrompt) {
      await ctx.session.hook("context", (event: any) => {
        if (!Array.isArray(event?.system)) return
        const present = event.system.some((p: any) => typeof p?.text === "string" && p.text.includes("## Subagent delegation"))
        if (!present) event.system.push({ type: "text", text: SYSTEM_HINT })
      })
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "discover_models",
        description:
          "Discover available models (on-demand). Use query to filter id/name/family (case-insensitive substring); pass free=true to list zero-cost models grouped by provider (free tiers and plan-included models, not just *-free names). Results mark free models and other providers offering the same model. No prices are shown.",
        input: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "optional substring filter over model id/name/family, e.g. 'gemini', 'claude', 'qwen'",
            },
            free: {
              type: "boolean",
              description:
                "list only free (zero-cost) models, grouped by provider — catches Nvidia free tier and plan-included models, not just *-free ids",
            },
          },
          additionalProperties: false,
        },
        execute: async (args: any) => {
          await registry.load()
          const query = typeof args?.query === "string" ? args.query.trim() : ""
          const freeOnly = args?.free === true
          const limit = freeOnly ? 500 : 20
          let res = registry.search(query || undefined, limit, { freeOnly })
          if (query && res.total === 0) {
            await registry.load({ force: true })
            res = registry.search(query, limit, { freeOnly })
          }
          if (res.models.length === 0) {
            if (freeOnly) {
              return {
                content: `No free models found${query ? ` matching "${query}"` : ""}. Free detection uses provider cost data and \`-free\` ids; try again after connecting more providers.`,
              }
            }
            const allCount = registry.all().length
            return {
              content: `No models matched query "${query}". Catalog has ${allCount} models. Try a broader query, e.g. discover_models("gemini").`,
            }
          }
          const content = freeOnly
            ? renderFreeResults(res.models, res.total, query)
            : renderSearchResults(res.models, registry.all(), res.total, query)
          return { content }
        },
      })

      editor.add({
        name: "task",
        description:
          "Launch a subagent in a parented child session — renders as a clickable Task pane inline in this chat. Native behavior when model is omitted (child inherits this session's model). Pass model (short or qualified 'provider/model') and optional variant (reasoning effort, e.g. 'high') to route the subagent to any model from any connected provider.",
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Short 3-5 word description of the task" },
            prompt: { type: "string", description: "The task for the subagent to perform" },
            subagent_type: {
              type: "string",
              description: "The agent for the subagent to use (e.g. 'build', 'plan', or a configured agent name). Omit to inherit the current agent.",
            },
            model: {
              type: "string",
              description:
                "model id — short name or qualified provider/model (e.g. 'google/gemini-2.5-flash'). Omit to inherit this session's model (native behavior).",
            },
            variant: {
              type: "string",
              description: "optional model variant / reasoning effort for the subagent (e.g. 'low', 'high', 'max')",
            },
          },
          required: ["description", "prompt"],
          additionalProperties: false,
        },
        execute: async (args: any, toolCtx: any) => {
          const prompt = String(args?.prompt ?? "").trim()
          const description = String(args?.description ?? "").trim()
          if (!prompt) return { content: "Error: prompt is required — what should the subagent do?" }
          if (!description) return { content: "Error: description is required — a short 3-5 word summary of the task." }

          const agent = String(args?.subagent_type ?? "").trim() || undefined
          const modelInput = String(args?.model ?? "").trim()
          const variant = String(args?.variant ?? "").trim() || undefined

          // Resolve the target model — or inherit (null) for native behavior.
          let entry: ModelEntry | null = null
          if (modelInput) {
            const resolved = await resolveModel(modelInput)
            if (resolved.kind === "not_found") return { content: formatNotFound(resolved) }
            if (resolved.kind === "ambiguous") return { content: formatAmbiguous(resolved) }
            entry = resolved.entry
          }

          try {
            const out = await execution.execute(
              entry,
              prompt,
              {
                sessionID: toolCtx.sessionID,
                messageID: toolCtx.messageID,
                signal: toolCtx.signal,
                onProgress: progressReporter(toolCtx),
              },
              { agent, variant, title: description },
            )
            return {
              content: out.output,
              metadata: {
                sessionId: out.sessionID,
                parentSessionId: toolCtx.sessionID,
                ...(entry ? { model: { providerID: entry.providerID, modelID: entry.modelID } } : {}),
              },
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const qualified = entry?.qualified ?? agent ?? "subagent"
            return {
              content: `task failed: ${errorHint(qualified, msg, entry?.providerID)}`,
              metadata: entry ? { model: { providerID: entry.providerID, modelID: entry.modelID } } : undefined,
            }
          }
        },
      })

      editor.add({
        name: "delegate",
        description:
          "Delegate a task to a specific model as a parented subagent (renders inline). Model may be short ('gemini-3.7') or qualified 'provider/model' ('google/gemini-2.5-flash'). If ambiguous, returns matches to retry with qualified id. Optional: agent (run the child as a named agent, e.g. 'plan') and variant (model reasoning variant, e.g. 'high' or 'max').",
        input: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "model id — short name or qualified provider/model (preferred, e.g. 'google/gemini-2.5-flash')",
            },
            task: { type: "string", description: "prompt/task to run with the target model" },
            agent: {
              type: "string",
              description: "optional agent for the child run (e.g. 'build', 'plan', or a configured subagent name)",
            },
            variant: {
              type: "string",
              description: "optional model variant / reasoning effort for the child run (e.g. 'low', 'high', 'max')",
            },
          },
          required: ["model", "task"],
          additionalProperties: false,
        },
        execute: async (args: any, toolCtx: any) => {
          const modelInput = String(args?.model ?? "").trim()
          const task = String(args?.task ?? "").trim()
          if (!modelInput) {
            return { content: "Error: model is required — e.g. 'google/gemini-2.5-flash' or 'gemini-3.7'. Use discover_models() to list options." }
          }
          if (!task) return { content: "Error: task is required — what should the delegated model do?" }

          const resolvedResult = await resolveModel(modelInput)
          if (resolvedResult.kind === "not_found") return { content: formatNotFound(resolvedResult) }
          if (resolvedResult.kind === "ambiguous") return { content: formatAmbiguous(resolvedResult) }
          const entry = resolvedResult.entry

          try {
            const out = await execution.execute(
              entry,
              task,
              {
                sessionID: toolCtx.sessionID,
                messageID: toolCtx.messageID,
                signal: toolCtx.signal,
                onProgress: progressReporter(toolCtx),
              },
              {
                ...(typeof args?.agent === "string" && args.agent.trim() ? { agent: args.agent.trim() } : {}),
                ...(typeof args?.variant === "string" && args.variant.trim() ? { variant: args.variant.trim() } : {}),
              },
            )
            return {
              content: out.output,
              metadata: {
                sessionId: out.sessionID,
                parentSessionId: toolCtx.sessionID,
                model: { providerID: entry.providerID, modelID: entry.modelID },
              },
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              content: errorHint(entry.qualified, msg, entry.providerID, entry.modelID),
              metadata: { model: { providerID: entry.providerID, modelID: entry.modelID } },
            }
          }
        },
      })
    })
  },
}
