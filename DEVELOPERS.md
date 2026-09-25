# opencode-subagent-delegate — Developer Documentation

> **Audience:** mid-level to senior engineers maintaining or extending this plugin.
> **Documented against:** plugin v1.6.0 · OpenCode **2.0.15–2.0.16** (V2) and **1.18.32** (V1) · September 2026.
> **Companion docs:** user-facing overview → [README.md](README.md); official OpenCode docs → [opencode.ai/docs](https://opencode.ai/docs) and the [V1→V2 migration guide](https://opencode.ai/v2/docs/migrate-v1).

Everything in this document is either derived from source, verified by live runs, or quoted from OpenCode's own documentation. Where a claim comes from an experiment, the evidence is named (log line, database query, or test name) so you can reproduce it.

---

## Contents

1. [Mental model in 60 seconds](#1-mental-model-in-60-seconds)
2. [Compatibility and versioning](#2-compatibility-and-versioning)
3. [Loading, install surfaces, and precedence](#3-loading-install-surfaces-and-precedence)
4. [Tools reference](#4-tools-reference)
5. [Routing policy and the system hint](#5-routing-policy-and-the-system-hint)
6. [Free detection in depth](#6-free-detection-in-depth)
7. [Architecture](#7-architecture)
8. [Registry and resolver internals](#8-registry-and-resolver-internals)
9. [Execution internals](#9-execution-internals)
10. [Configuration reference](#10-configuration-reference)
11. [Security model](#11-security-model)
12. [Testing and verification](#12-testing-and-verification)
13. [Development workflow](#13-development-workflow)
14. [Troubleshooting](#14-troubleshooting)
15. [File map](#15-file-map)
16. [Appendix A — measured catalogs](#appendix-a--measured-catalogs)
17. [Appendix B — live test matrix](#appendix-b--live-test-matrix)
18. [Appendix C — glossary](#appendix-c--glossary)

---

## 1. Mental model in 60 seconds

OpenCode already knows every model you can use (via `/connect`, `opencode.json`, and the models.dev catalog). What it does **not** give the assistant is a *tool-level way* to run a subagent on an arbitrary one of those models. This plugin adds exactly that, on both plugin APIs:

```ts
// index.ts — the entire public entrypoint
import { ModelRouterPlugin } from "./v1.js"
import v2 from "./v2.js"

export default {
  id: "opencode-subagent-delegate",
  setup: v2.setup,          // called by OpenCode 2.x
  server: ModelRouterPlugin, // called by OpenCode 1.18.29+
}
```

Three tools are registered:

| Tool | Purpose |
|---|---|
| `discover_models(query?, free?)` | On-demand catalog search; free-tier listing grouped by provider |
| `task(description, prompt, subagent_type?, model?, variant?)` | Routing-aware override of the built-in `task` |
| `delegate(model, task, agent?, variant?)` | Explicit cross-model delegation |

**Core invariants** (do not break these; they are the product):

1. **No prices, ever.** Cost data may only be reduced to a boolean `free`. The catalog shown to models never contains numbers.
2. **Explicit identity.** Execution targets are always `(providerID, modelID)`. Ambiguity returns a match list; provider choice belongs to the user.
3. **The catalog never enters context.** The system hint is a fixed string; discovery happens through tool calls.
4. **One shared pure core.** Rendering and free detection live in `listing.ts` / `config-models.ts`; runtime surfaces stay in `v1.ts` / `v2.ts`. This is the only reason V1 and V2 output cannot drift.

---

## 2. Compatibility and versioning

| OpenCode | Entry called | Status |
|---|---|---|
| 2.x — tested **2.0.15** and **2.0.16** | `setup(ctx)` | ✅ live-tested (tool registration, delegation, free detection) |
| 1.18.**29** – 1.18.**32** — tested **1.18.32** | `server(input, options)` | ✅ live-tested (same suite) |
| 1.18.0 – 1.18.28 | — | ❌ pin `opencode-subagent-delegate@1.2.5` (function-export plugin) |

`package.json` declares:

```json
"engines": { "opencode": ">=1.18.29" }
```

OpenCode reads `engines.opencode` during plugin load (`checkPluginCompatibility` in `packages/opencode/src/plugin/shared.ts`, v1.18.32 source). An older 1.x release refuses the plugin with a clear message instead of failing silently.

### 2.1 Why 1.18.29 is the floor

The dual-entrypoint shape is the officially documented migration pattern:

> “A package can temporarily expose both implementations from one default export. V1 calls `server()` and V2 calls `setup()`. […] V1 object entrypoints are supported in OpenCode `1.18.29` and newer.”
> — [Migrate plugins from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)

The v1.18.32 loader source (`plugin/shared.ts`) confirms the mechanics:

```ts
export function readV1Plugin(mod, spec, kind, mode = "strict") {
  const value = mod.default
  if (!isRecord(value)) { if (mode === "detect") return; throw … }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return
  const server = "server" in value ? value.server : undefined
  …
  if (server !== undefined && typeof server !== "function") throw …
  if (kind === "server" && server === undefined) throw …
  return value
}
```

Key consequences for our shape `{ id, setup, server }`:

- V1 detection triggers on `id` being present, then **requires** `server` to be a function — satisfied.
- Extra keys (`setup`) are ignored by V1.
- V2 validates `default` against a schema requiring `id` + `setup`/`effect`; the extra `server` key is tolerated. This was verified empirically (a probe plugin with exactly this shape loaded on 2.0.15 before the port was written).

### 2.2 Version drift you should expect

OpenCode auto-updates. During one working session the machine moved **2.0.15 → 2.0.16** mid-testing (visible in logs: `cli starting version=2.0.16`). Consequences:

- The CLI (`opencode run`) and the background service may briefly run different builds. Re-verify after updates if something behaves oddly.
- Storefront facts (catalogs, credential storage) can change shape between builds. This document notes the version for every observation.

---

## 3. Loading, install surfaces, and precedence

### 3.1 npm package

**V2** (`~/.config/opencode/opencode.json` or project config):

```jsonc
{
  "plugins": [
    "opencode-subagent-delegate",
    // options use the object form; they arrive as ctx.options in V2
    { "package": "opencode-subagent-delegate", "options": { "hintInSystemPrompt": true } }
  ]
}
```

**V1** (`plugin` key, tuple form):

```jsonc
{
  "plugin": [
    "opencode-subagent-delegate",
    ["opencode-subagent-delegate", { "hintInSystemPrompt": true }]
  ]
}
```

OpenCode fetches and executes the raw TypeScript (`main: index.ts`). There is no build step; Bun handles `.ts` and `.js`-extension specifiers.

### 3.2 Local drop-in (development)

OpenCode auto-loads plugin files in `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global). Two layouts work on V2:

- **Loose file** — `plugins/foo.ts` exporting the default plugin object.
- **Directory plugin** — `plugins/foo/index.ts`; supporting modules live beside it and are **not** loaded as plugins.

This repository uses the directory layout for the local dev copy because the shared modules must resolve:

```text
~/.config/opencode/plugins/subagent-delegate/
├── index.ts          # copy of v2.ts (default export { id, setup })
├── listing.ts        # shared helpers
└── config-models.ts  # shared helpers
```

Evidence (server log):

```text
msg="loading plugin" id=/Users/…/plugins/subagent-delegate entrypoint=file:///…/plugins/subagent-delegate/index.ts
```

No load line appears for `listing.ts` or `config-models.ts` — supporting modules are ignored by the scanner.

V1 loads loose files only (one file per plugin). For a V1 local drop-in, point `plugin` at the **repository directory** — the v1.18.32 loader resolves a directory with `package.json` to its `main`:

```jsonc
{ "plugin": ["/absolute/path/to/opencode-subagent-delegate"] }
```

### 3.3 Precedence

Load order (both runtimes): global config → project config → global plugin dir → project plugin dir. For tools, OpenCode's documented rule applies: **a later valid registration overrides the same effective tool name** — which is how the `task` override works. Do not install npm + local copies simultaneously; both register `task`/`delegate`/`discover_models` and you will see duplicate entries.

### 3.4 Runtime log lines to look for

```text
~/.local/share/opencode/log/opencode.log

msg="loading plugin" id=… entrypoint=file:///…        ← attempted
message="failed to load plugin" … cause="…"           ← failed (with reason)
```

Common failure text and meaning:

| Log text | Meaning |
|---|---|
| `Missing key at ["default"]` | plugin module has no default export (V1-style only) |
| `Expected object at ["default"]` | default export is a function instead of `{ id, setup }` |
| `Plugin must export a default definition with an id and an effect or setup function` | wrong shape |

---

## 4. Tools reference

### 4.1 `discover_models(query?, free?)`

**Search:** case-insensitive substring over `id`, `name`, and `family` (diacritics not normalized; `-_.` are ignored in matching, see §8.2).

**Normal results** (≤ 20 lines) annotate free status and same-model siblings:

```text
Found 5 of 5 matching "glm-5.3-flash":
- zai-coding-plan/glm-5.3-flash — GLM-5.3-Flash family:glm-flash ctx:1000000 · free · also: llmgateway, opencode-go, opencode
- opencode-go/glm-5.3-flash — GLM-5.3-Flash family:glm-flash ctx:1000000 · also: llmgateway, opencode, zai-coding-plan (free)
- nvidia/z-ai/glm-5.3-flash — GLM-5.3-Flash family:glm-flash ctx:1000000 · free
```

- `· free` — this provider reports the model as zero-cost (or naming marks it free, §6).
- `· also: …` — other providers carrying the **same model id**; free siblings carry `(free)`. Capped at 4 entries plus `+N`.
- Sibling matching is by exact `modelID`. Nested ids are distinct ids: `nvidia/z-ai/glm-5.3-flash` (`modelID = z-ai/glm-5.3-flash`) is not a sibling of `zai-coding-plan/glm-5.3-flash` — by design; only the runtime knows they are the same family.

**Free results** (`free: true`) are grouped by provider so rate-limit trade-offs stay visible:

```text
Free models — 138 across 8 providers:
- nvidia (99): z-ai/glm-5.3-flash, deepseek-ai/deepseek-v4-flash, …
- opencode (7): big-pickle, mimo-v2.6-flash-free, …
- zai-coding-plan (7): glm-4.7, glm-5-turbo, glm-5.2, …
- opencode-go (1): space-bunny-free
Route with delegate(model="provider/model", task="..."). Free tiers differ in rate limits — *-free (OpenCode Zen) is the most generous; Nvidia's free tier is heavily rate-limited.
```

- Up to 6 ids are shown per provider (then `…`); **all** providers are listed with exact counts.
- The list is bounded (~6 × providers lines), never the full 100+ model dump.

**Miss behavior:** if a query returns 0 results the registry force-refreshes once (picks up mid-session auth) and retries. Free with no matches returns a dedicated message.

### 4.2 `task(description, prompt, subagent_type?, model?, variant?)` — native override

| Argument | Required | Behavior |
|---|---|---|
| `description` | ✅ | 3–5 words; becomes the child session title (skips auto-title model call) |
| `prompt` | ✅ | What the subagent should do |
| `model` | — | Short or qualified id. **Omitted → child inherits the invoking session's model** (explicitly, §9.2) |
| `variant` | — | Reasoning effort for the child (`low`…`max`) |
| `subagent_type` | — | Named agent to run the child as (`build`, `plan`, custom). Omitted → inherit |

Because it keeps the built-in name `task`, the TUI mounts its native Task renderer: the child appears as a clickable, live pane inside the parent chat.

### 4.3 `delegate(model, task, agent?, variant?)`

Explicit delegation. `model` and `task` are required; `agent`/`variant` optional. No `description`; the child title is derived from the task text.

**Resolution algorithm** (`resolver.ts` for V1, mirrored in `v2.ts`):

| Input shape | Path |
|---|---|
| `"provider/model"` (contains `/`) | Split on the **first** `/`; exact `(providerID, modelID)` lookup; case-insensitive provider fallback |
| `"kimi-k3"`, `"gemini 3.7"` | Normalized fuzzy search (score table below); exact-id candidates win outright |
| 1 candidate | resolved |
| 2+ candidates | **ambiguity** → match list returned; agent asks the user (§5) |
| 0 candidates | force refresh → retry → `not_found` with a `discover_models` suggestion |

Scoring (`scoreMatch`, lower is better): exact id `0` → exact qualified `1` → id prefix `10+Δ` → name prefix `11` → family exact `12` → id substring `20` → name `21` → family `22` → qualified `23` → no match `999`. Tie-breakers: newer `releaseDate`, larger context, lexicographic.

**Error envelopes:** provider `ModelUnavailableError` → suggests another provider for the same family; auth errors → point at the credential store; both stay readable for retry.

### 4.4 Output conventions (all tools)

- ≤ 20 lines for search results; free listings ≤ 6 ids/provider.
- No prices, no token limits beyond `ctx:` (context window), no secrets.
- Errors are plain sentences the model can act on — never stack traces.

---

## 5. Routing policy and the system hint

The plugin injects one fixed hint into the agent loop's system prompt. It is intentionally short — the catalog is never embedded.

**Injected text (v1.6.0):**

```text
## Subagent delegation — opencode-subagent-delegate
Run subagents on any connected model; each run appears as a clickable inline Task pane. Use them when they add value (parallel work, isolation, second opinions); skip trivial single-step replies.
Tools:
- `task(description, prompt, subagent_type?, model?, variant?)` — preferred; omit `model` to inherit this session's model.
- `delegate(model, task, agent?, variant?)` — explicit; a model is required.
- `discover_models(query?)` — exact ids when unsure (substring over id/name/family, ≤20 rows, no prices).
Routing policy:
- No model requested → call task WITHOUT `model`; the subagent inherits the current model. Never route to another model on your own.
- A model class is requested (free / cheap / fast / strong / local) → discover_models first; for free call discover_models(free=true) — zero-cost models per provider (Zen *-free, Nvidia, plan-included); prefer *-free for the most generous limits (Nvidia is rate-limited).
- A specific model is named → resolve it; if the same model exists on several providers (or the id is ambiguous), show the matches and ask the USER which one to use — never choose a provider yourself. Route to their choice; on an unknown id, discover_models first.
Pick models you know exist; never guess from price. Keep `description` to 3-5 words.
```

### 5.1 Injection points (both documented hooks)

| Runtime | Hook | Official mapping |
|---|---|---|
| V1 | `experimental.chat.system.transform` → `out.system.push(SYSTEM_HINT)` | listed in the V1→V2 mapping table |
| V2 | `ctx.session.hook("context", (event) => event.system.push({ type: "text", text }))` | “edit `event.system`” |

The V2 hook runs immediately before each agent-loop model request; auxiliary requests (title/compaction) are unaffected. A dedup guard keeps the hint from being appended twice if another copy registers.

Disable with `hintInSystemPrompt: false`.

### 5.2 Ask-the-user flow (ambiguity)

When a named model exists on several providers, the tool result is:

```text
Multiple providers offer "glm-5.3-flash" — 5 matches:
  - llmgateway/glm-5.3-flash  (GLM-5.3-Flash)
  - opencode-go/glm-5.3-flash  (GLM-5.3-Flash)
  - opencode/glm-5.3-flash  (GLM-5.3-Flash)
  - zai-coding-plan/glm-5.3-flash  (GLM-5.3-Flash)
  - nvidia/z-ai/glm-5.3-flash  (GLM-5.3-Flash)
Show the matches to the user, ask which one to use, then retry with that exact qualified id.
```

End-to-end verification (see Appendix B): the agent presented the options and **did not create a child session**; after the user's answer (“Go with `zai-coding-plan/glm-5.3-flash`”) the follow-up turn executed on that provider.

**Why prompt-level and not a UI prompt?** OpenCode's plugin API exposes permission asks, not arbitrary blocking questions; returning the match list and letting the conversational agent ask is the documented-friendly pattern and keeps the tool side-effect free.

---

## 6. Free detection in depth

The purpose is pragmatic: users want free capacity, and free tiers differ in rate limits. The plugin must answer “what is free, and on which providers?” without ever showing prices.

### 6.1 Signal sources

| # | Source | Field | Available when |
|---|---|---|---|
| 1 | V2 runtime catalog | `ctx.model.list()` → `ModelInfo.cost: Tier[]` | model materialized by the runtime |
| 2 | V1 runtime catalog | `client.config.providers()` → model `cost: { input, output, cache {read, write}, tiers? }` | provider connected |
| 3 | Naming | `modelID` suffix / display name | always |
| 4 | `opencode.json` | `provider.<id>.models.<key>.{id,name,cost}` | entry exists |

Sources 1/2 and 3 are evaluated per entry; source 4 is merged in by `config-models.ts` whenever the runtime catalog is available (dual-source design, §6.3).

### 6.2 The formula

```ts
// listing.ts
export function isFreeModel(modelID, name, cost): boolean {
  const tiers = Array.isArray(cost) ? cost : []
  const zeroCost =
    tiers.length > 0 &&
    tiers.every((t) => (Number(t?.input) || 0) === 0 && (Number(t?.output) || 0) === 0)
  return zeroCost || /-free$/i.test(modelID) || /\bfree\b/i.test(String(name ?? ""))
}
```

Decision table (all rows unit-tested):

| cost tiers | name/id signal | result |
|---|---|---|
| all zero | — | ✅ free |
| missing / `[]` | `*-free` or “Free” | ✅ free |
| missing / `[]` | none | ❌ not free (unverifiable) |
| any non-zero | `*-free` | ✅ free (union is intentionally permissive) |
| any non-zero | none | ❌ not free |

V1 evidence that cost is real (probe of `client.config.providers()`, 1.18.32):

```json
// free, cost-zero tiers
{"key":"ling-3.0-flash-fin-free","cost":{"input":0,"output":0,"cache":{"read":0,"write":0}}}
{"key":"space-bunny-free","cost":{"input":0,"output":0,"cache":{"read":0,"write":0}}}
{"key":"baai/bge-m3","cost":{"input":0,"output":0,"cache":{"read":0,"write":0}}}
// paid, tiered
{"key":"gpt-5.4","cost":{"input":2.5,"output":15,"cache":{...},"tiers":[{"input":5,"output":22.5,...}]}}
```

V2 evidence (`tools.opencode.models`): free models report `cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]`; config-only providers (bailian/mimo) report `cost: []` — hence the naming/config paths matter.

### 6.3 Dual-source merge (config ↔ runtime catalog)

`config-models.ts` is the only reader of `opencode.json` for free signals:

```text
free = primary cost       (runtime)
    ∪  primary naming     (runtime id/name)
    ∪  config naming      (opencode.json id/name)
    ∪  config cost        (opencode.json, if declared)
```

**Matching rule — exact and same-provider only:**

```ts
c.providerID === entry.providerID &&
(c.modelID === entry.modelID || c.key === entry.modelID)
```

- A config entry joins a runtime entry only when **both provider and id** agree (id = config `id` or raw key).
- Unrelated models are never combined; cross-provider combinations are impossible by construction (unit test: “never combines across providers”).
- Config-only models (no runtime counterpart) are **appended** as entries.
- Enrichment also backfills missing `family`/`context`/`releaseDate`; existing values are kept.
- The merge returns new objects; inputs are not mutated (unit-tested).

**Fallback semantics:** `fetchFromFilesystem` (config + auth-filtered model cache) is invoked in parallel but contributes **only entries the enriched primary set does not already contain**, and is the sole source when the runtime catalog returns nothing (boot race, auth import, offline). It is *not* the free-detection path.

**Live proof (both runtimes):** a temporary custom provider was added to `opencode.json`:

```jsonc
"probe-free-test": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Probe Free Test",
  "options": { "apiKey": "probe", "baseURL": "http://127.0.0.1:9/v1" },
  "models": { "probe-model-free": { "name": "Probe Model Free", "limit": { "context": 1000 } } }
}
```

- V2 (`ctx.model.list()` reports it with `cost: []`): `discover_models("probe-model")` → `probe-free-test/probe-model-free — Probe Model Free ctx:1000 · free`.
- V1 (1.18.32, `config.providers()` + config): identical output.
- After removal the live catalog no longer matches the probe query.

### 6.4 Why not rate-limit data?

Rate limits are provider policy, not catalog metadata; they are not exposed anywhere in the runtime API. The plugin therefore documents the known asymmetry in the free listing footer (Zen `*-free` most generous; Nvidia heavily rate-limited) instead of pretending to rank limits.

### 6.5 Extension point

To add a new free signal: extend `isFreeModel` (§6.2) and unit-test the truth table; if it needs new data, thread it through `ModelEntry`/`ConfigModel` at the fetch sites. Never surface prices — reduce new cost-like data to booleans.

---

## 7. Architecture

### 7.1 Module graph

```text
index.ts                     dual entrypoint  { id, setup, server }
  ├── v2.ts                  V2 implementation (self-contained runtime adapter)
  │     ├── listing.ts       shared: ModelEntry, isFreeModel, renderers        ┐ pure,
  │     └── config-models.ts shared: readConfigModels, mergeConfigModels      ┘ no plugin APIs
  └── v1.ts                  V1 implementation (factory → hooks)
        ├── registry.ts      SDK catalog + FS fallback (imports both shared modules)
        ├── resolver.ts      provider/model parsing, ambiguity, preferredProviders
        ├── execution.ts     V1 SessionExecutionAdapter (parented child sessions)
        ├── listing.ts       (same shared modules)
        └── config-models.ts

test/listing.test.ts         12 checks — render + free truth table
test/config-models.test.ts   14 checks — union table, matching, reader
```

### 7.2 Why two implementations but one shared core

V1 and V2 plugin contexts are genuinely different surfaces (documented: “V1 plugin implementations do not run in V2”):

- V1 factory: `({ project, client, $, directory, worktree }) => hooks`; tools via the `tool()` helper; SDK client for everything.
- V2: `setup(ctx)`; tools via the synchronous `ctx.tool.transform(editor.add)` editor; sessions/agents/models via domain APIs.

That difference is confined to the runtime adapters. Everything that is *policy* — what is free, how lists look, which providers are siblings — lives in the shared pure modules so both runtimes ship identical behavior. The unit-test seam is deliberate: pure logic goes in `listing.ts`/`config-models.ts` and is tested without a runtime; adapters stay thin.

**Node test caveat:** the shared modules import each other with explicit `.ts` specifiers (`./listing.ts`) so plain Node’s type stripping can resolve them in tests; Bun (OpenCode) resolves both `.ts` and `.js` specifiers. Files that only run under OpenCode use `.js` specifiers by convention. Don’t “fix” one style into the other without checking `npm test`.

### 7.3 Catalog composition at load time (V2)

```text
load() ── TTL 300s ──► fetchMerged()
  ├─ ctx.model.list()        → primary entries (cost, name, family, context)
  ├─ opencode.json models    → config signals (mergeConfigModels: enrich + append)
  └─ filesystem fallback     → adds only entries still missing
```

Sort by `qualified`; cache in memory; `load({ force: true })` bypasses TTL. V1 is identical with `client.config.providers()` as the primary call.

---

## 8. Registry and resolver internals

### 8.1 Registry

- **Primary fetch attempts (V1):** `client.config.providers()` (documented in the v1 SDK as the merged catalog) with the legacy `client.provider.all()` shape as a secondary attempt; wrong shapes fall through to the empty list.
- **Filesystem fallback:** global `opencode.json` custom providers + `auth.json`-filtered `~/.cache/opencode/models.json` (filters out the 200+ unconfigured providers so free lists stay meaningful).
- **TTL:** `registryTtlMs`, default `300000`.
- **Force refresh:** on empty search results, on resolution misses, or via `load({ force: true })`.

### 8.2 Normalization and scoring

`normalize()` lowercases and strips `[-_. ]`; exact-id comparison uses this form (so `glm-5.3-flash` ≡ `glm53flash` for matching, while execution always uses the exact stored id). Scoring table in §4.3.

### 8.3 Resolver

- Qualified inputs split on the **first** `/` — `openrouter/google/gemini-3.7` means provider `openrouter`, model `google/gemini-3.7`.
- Exact-id narrowing: if any candidate’s id equals the query (normalized), non-equal candidates are dropped. This is why `mimo-v2.6-flash-free` resolves uniquely even though `mimo-v2.6-flash` spans three providers.
- `preferredProviders` tie-break applies **only when exactly one** candidate comes from the preferred provider; otherwise the ambiguity list stands (determinism over guesswork).
- No price data exists in the resolver at all.

---

## 9. Execution internals

### 9.1 V1 flow

```ts
client.session.create({ body: { parentID, title } })            // parented child
client.session.prompt({ path: { id }, body: { model, parts } }) // blocks until done
// during the run: live metadata PATCH via client._client.patch for the TUI pane
// on abort: ctx.abort → /session/{id}/abort
```

Output is wrapped in a `<task id="…" state="completed">` envelope and the tool result carries `metadata.sessionId` / `parentSessionId` for the inline renderer. Historical verification (1.2.x era) confirmed parent linkage in server logs.

### 9.2 V2 flow

```ts
ctx.session.create({ model?, agent?, title? })   // no parentID exists in SessionCreateInput
ctx.session.prompt({ sessionID, text })          // admits the task
await waitForCompletion(sessionID)               // hardened wait, below
ctx.session.context({ sessionID })               // read final assistant text
```

**Inheritance is explicit.** When no model was requested, the plugin reads the invoking session (`ctx.session.get({ sessionID })` → `SessionInfo.model`) and passes that `(providerID, id, variant)` to `create`. We do not rely on runtime defaults for a fresh child session.

**Parent linkage.** `SessionCreateInput` (client-types @2.0.15) has `id?`, `title?`, `agent?`, `model?`, `location?`, `metadata?`, `permissions?` — **no `parentID`**; only forks (`session.fork`/`session.import`) carry one. The plugin still sends `parentID` best-effort and retries without on rejection; live checks show V2 children are standalone (`parent_id = NULL`). The inline Task pane is driven entirely by ToolResult `metadata: { sessionId, parentSessionId, model? }` — the same contract the TUI consumes.

**Hardened wait** (`waitForCompletion`):

1. Start `ctx.session.wait({ sessionID })` (documented API).
2. Race it against polling `ctx.session.get().time.idle` every 3 s — defeats a missed idle event.
3. Emit `ctx.progress({ status: "subagent running Ns" })` every ≥10 s — long waits never look hung.
4. Hard ceiling **30 minutes**: interrupt the child and return a clear error instead of hanging.

**Why the hardening exists (measured).** With `session.wait()` alone, a run that completed normally in 2.2 s reported idle 153 s late when a second wait registered concurrently:

```text
19:27:03.545 prompt admitted (child B)
19:27:05.772 wait returned (child A)      ← 2.2 s
19:29:36.573 wait returned (child B)      ← 153 s (child B had already finished; message/idle timestamps shifted identically)
```

Follow-up experiments showed the same ~3–150 s spread when two delegations hit the same free-tier provider — the provider serializes the second request; the run itself stays active (message completion, session idle, and wait all move together). Conclusion: not a plugin bug; the plugin’s job is to stay informative and bounded. Solo delegations return in seconds; parallel ones queue on the provider.

**Derived titles.** `delegate` titles the child from the task text (≤48 chars) — one fewer auto-title model call per delegation, which matters on rate-limited providers.

**Abort.** The tool’s abort signal calls `ctx.session.interrupt({ sessionID })` on the child.

### 9.3 Result shape

The final assistant text is extracted from `session.context` (all `{type:"text"}` parts of the last assistant message). Errors carry readable hints: `ModelUnavailableError` suggests re-discovery; auth errors point at the credential store. ToolResult metadata always includes the child session id for the pane.

---

## 10. Configuration reference

| Option | Type | Default | Notes |
|---|---|---|---|
| `preferredProviders` | `Record<string, string>` | `{}` | Makes a short name deterministic **only when exactly one** candidate comes from the preferred provider |
| `registryTtlMs` | `number` | `300000` | Catalog cache TTL |
| `hintInSystemPrompt` | `boolean` | `true` | Inject the routing hint |

V1 passes options as the tuple’s second element; V2 passes the object form and the plugin reads `ctx.options` (see §3.1). Unknown options are ignored; the plugin also reads nested `{"opencode-subagent-delegate": {…}}` shapes defensively.

---

## 11. Security model

| Property | How |
|---|---|
| Keys never leave the machine | Registry reads only provider/model metadata; credentials are never read by this plugin at all |
| `auth.json` never logged | No logging of credential files anywhere in the codebase |
| No prices in model context | Cost data is reduced to the boolean `free` before rendering |
| Registry fields exposed | `providerID`, `modelID`, `name`, `family`, `context`, `releaseDate`, `free` |
| Child processes | None — no `spawn`/`exec` anywhere in the plugin |

---

## 12. Testing and verification

### 12.1 Unit tests — `npm test` (26 checks)

| Suite | Checks | Covers |
|---|---|---|
| `test/listing.test.ts` | 12 | `isFreeModel` truth table (zero tiers, missing cost, name fallback, mixed/paid, empty array); `renderSearchResults` (free marker, sibling annotation with free marks, `+N` cap); `renderFreeResults` (provider grouping, counts, per-provider cap, query header) |
| `test/config-models.test.ts` | 14 | union table (6 rows), matching rules (cross-provider isolation, key-vs-id, append config-only, enrichment, no mutation, empty config), reader (fixture file + missing file) |

Node 22+ executes the TypeScript directly (`npm test` runs `node test/*.test.ts`); no build step, no test framework.

### 12.2 Live verification (summarized; full matrix in Appendix B)

**V1 (1.18.32, isolated HOME):**
- Dual entrypoint loads; `server()` called
- `discover_models("mimo")` → 20 of 24 catalog entries
- `discover_models(free=true)` → correctly grouped free list (31 on `opencode`, 2 on `opencode-go` at that snapshot)
- `delegate(opencode/mimo-v2.6-flash-free)` → `PONG`
- SDK probe: `client.config.providers()` = the 14 connected providers, every model carrying `cost` (zero-cost samples verified); `provider.list()` = 223-provider catalog
- Dual-source probe: config-only model detected free via `opencode.json`

**V2 (2.0.15–2.0.16, live machine):**
- Dual shape loads (empirical probe before implementation); tools register through the V2 tool editor
- Routing policy matrix — no model → inherit; class “free” → discovered + routed; named unique → routed; named multi-provider → asks user, no child created; follow-up choice → executed on the chosen provider
- Free listing (cost-based, Nvidia + plan-included), sibling annotations, config-only probe model detected free
- Abort wiring; progress/ceiling behavior; provider queueing documented

### 12.3 Reproducing the live tests

**V2 probe provider** (undo afterwards): add the block from §6.3 to the global `opencode.json`, touch the plugin file to force a reload, then

```text
discover_models("probe-model")            → expect · free
discover_models("probe", free=true)       → expect probe-free-test (1)
```

**V1 isolated recipe** (no interference with the real install):

```bash
mkdir -p /tmp/v1test
HOME=/tmp/v1test bash -c 'curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.32'
mkdir -p /tmp/v1test/.config/opencode /tmp/v1test/.local/share/opencode
# config: {"plugin": ["<repo>", "/tmp/v1probe/index.ts"], "model": "opencode-go/deepseek-v4.1-flash", "provider": {…probe…}}
# auth:   copy the v1-format auth.json into /tmp/v1test/.local/share/opencode/
HOME=/tmp/v1test /tmp/v1test/.opencode/bin/opencode run "Call discover_models once with query 'probe-model'."
```

Pitfalls learned the hard way:

- A custom `@ai-sdk/openai-compatible` provider **must set `options.baseURL`** or V1 exits immediately at startup.
- Do **not** call the SDK client during plugin initialization in V1 — it can deadlock startup. Defer with `setTimeout` (the probe does).
- v1 `run` has no `--auto` flag; plugin tools execute without it.

---

## 13. Development workflow

```bash
npm install          # dev deps: typescript, @opencode-ai/plugin 1.4.9, @opencode-ai/sdk 1.4.9
npm test             # 26 unit checks (Node executes TS directly)
npm run typecheck    # tsc --noEmit (strict)
npm pack --dry-run   # inspect the publish tarball (10 files + test excluded? see below)
npm publish          # requires npm auth
```

- **TypeScript 7** with `allowImportingTsExtensions` (needed by the `.ts` import in `config-models.ts`); `@opencode-ai/sdk` is pinned to exactly `1.4.9` so the typechecker sees a single SDK copy (a hoisted 1.18.x copy conflicts with the one nested under `@opencode-ai/plugin` — root cause of a real TS2322 we fixed in 1.3.0).
- **No build step.** The package ships raw TypeScript; OpenCode executes it.
- **Adding a tool:** V2 — `editor.add({ name, description, input: <JSON Schema>, execute })` inside the existing `ctx.tool.transform`; V1 — add to the `tool` map with the `tool()` helper and Zod schemas. Keep names collision-free or intentionally override.
- **Changing the hint:** edit `SYSTEM_HINT` in **both** `v1.ts` and `v2.ts` (identical text) and update §5 here.
- **Releasing:** bump `version`, add a README changelog entry, update this document’s version stamp, run `npm test` + `npm run typecheck` + `npm pack --dry-run`, commit `vX.Y.Z — …`, tag, push, publish.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `failed to load plugin … Missing key at ["default"]` | module has no default export | export `{ id, setup, server }` |
| `Expected object at ["default"]` | default export is a function | same as above |
| Tools registered twice | npm + local copy both installed | remove one |
| `discover_models` free list empty | no zero-cost or `-free` models among connected providers | connect a provider; check `discover_models(free=true)` after a force refresh |
| Model resolves to an unexpected provider | short name matched a different family | use the qualified id from the ambiguity list |
| Child seems to hang | provider queueing a concurrent request (free tiers) | wait — progress updates continue; results arrive; spread parallel work across providers |
| V1 plugin invisible | OpenCode < 1.18.29 | pin plugin `1.2.5` |
| V2 child pane not nested | V2 sessions cannot set `parentID` | expected; the pane uses ToolResult metadata |
| Catalog looks stale | TTL (5 min) | any empty search force-refreshes; or restart |

Log location: `~/.local/share/opencode/log/opencode.log` (grep for `loading plugin`, `failed to load`, `configuration normalization`).

---

## 15. File map

| File | Runtime | Role |
|---|---|---|
| `index.ts` | both | Dual entrypoint `{ id, setup, server }` |
| `v2.ts` | V2 | Self-contained implementation: tool editor, session APIs, hardened wait |
| `v1.ts` | V1 | Factory returning hooks/tools; hint via system transform |
| `registry.ts` | V1 | Catalog sources, TTL cache, scored search, config enrichment |
| `resolver.ts` | V1 | `provider/model` parsing, ambiguity, preferredProviders |
| `execution.ts` | V1 | Child-session adapter, XML envelope, live metadata PATCH |
| `listing.ts` | both | Entry shape, `isFreeModel`, renderers (pure) |
| `config-models.ts` | both | `opencode.json` reader + signal merge (pure except file read) |
| `test/listing.test.ts` | dev | 12 checks |
| `test/config-models.test.ts` | dev | 14 checks |
| `tsconfig.json` | dev | Strict typecheck (includes tests) |

---

## Appendix A — measured catalogs

Snapshot (Sep 2026, this machine's provider set: 14 connected providers). Numbers move as providers rotate models — treat them as scale indicators, not constants.

| Metric | V2 (`ctx.model.list()`) | V1 (`config.providers()`) |
|---|---|---|
| Providers connected | 14 | 14 |
| Models in catalog (live snapshot) | ~512 | 640 |
| Free models (measured before rotation) | 138 across 8 providers | 31 on `opencode` + 2 on `opencode-go` (snapshot) |
| Cost shape | `cost: Tier[]` (`{input, output, cache}`); empty array for config-only providers | `cost: {input, output, cache{read, write}, tiers?}` always present |
| Model counts differ | V1 surfaced more models at the same moment; V1 also lists the 223-provider catalog via `provider.list()` | — |

Cross-provider duplication study (models.dev × active providers): **114 of 430 model ids exist on 2+ providers**. Largest families: `deepseek-v4-flash` (5 providers), `glm-5.3-flash` (5), `kimi-k3` (4 exact ids; 6 rows counting variants), `gemini-3.x-flash` (4), `mimo-v2.x` (4).

Free inventory examples measured: `opencode` 33 `*-free` ids in the catalog snapshot (7 live at one moment), `opencode-go` 2, `nvidia` 101 zero-cost, `zai-coding-plan` 7 plan-included, `minimax*` 7 each, `google` 2.

---

## Appendix B — live test matrix

**Routing policy (V2, 2.0.15–2.0.16):**

| Test | Prompt shape | Result | Child session |
|---|---|---|---|
| T1 inherit | “use a subagent… no model” | ✅ | `opencode-go/deepseek-v4.1-flash` (parent's model) |
| T2 class free | “any free model” | ✅ | `opencode/mimo-v2.6-flash-free` |
| T3 named unique | `mimo-v2.6-flash-free` | ✅ | routed directly |
| T3b named unique (Nvidia) | `nvidia/z-ai/glm-5.3-flash` | ✅ | ran on Nvidia free tier |
| T4 named multi | `kimi-k3` / `glm-5.3-flash` | ✅ | **no child**; agent asked the user |
| T4b follow-up | “Go with `zai-coding-plan/glm-5.3-flash`” | ✅ | child on Z.AI, returned `MULTI-PONG` |
| Direct ambiguity | `delegate("kimi-k3")` tool call | ✅ | match list returned, nothing executed |
| Direct qualified | `delegate("zai-coding-plan/glm-5.3-flash")` | ✅ | `ZAI-PONG` |

**Free detection:**

| Test | Result |
|---|---|
| V2 `discover_models(free=true)` | 138 across 8 providers, grouped, footer note |
| V2 union probe (`probe-free-test`) | `· free` via config name while runtime cost = `[]` |
| V1 union probe | identical output through `config.providers()` + config |
| V1 SDK cost probe | zero-cost + tiered samples captured (§6.2) |
| Unit truth table (6 rows) | all pass |

**Concurrency observations (free tier):** solo delegation 7 s; second concurrent child 38.5 s / 124 s / 153 s in three runs (provider queueing); both children always completed successfully.

---

## Appendix C — glossary

| Term | Meaning |
|---|---|
| **V1 / V2** | OpenCode 1.x (factory + `server()` entry) / OpenCode 2.x (`setup(ctx)` entry) |
| **Dual entrypoint** | one default export serving both runtimes via documented object form |
| **Primary source** | the runtime model catalog (V2 `ctx.model.list()`, V1 `config.providers()`) |
| **Fallback** | `fetchFromFilesystem` — used only when the primary source fails/returns nothing |
| **Free signal** | any of: zero-cost tiers, `-free` id, “free” name, config-declared signal |
| **Ambiguity list** | match list returned when a named model spans providers; user chooses |
| **Task pane** | TUI child-session card rendered from ToolResult metadata |
| **Enrichment** | merging `opencode.json` signals into primary entries (exact same-provider match) |

---

*Maintainers: keep the version stamp, the hint text (§5), the appendix snapshots, and the file map in sync with releases. The README stays user-facing; this file is the engineering record.*
