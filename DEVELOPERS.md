# opencode-subagent-delegate — Developer Documentation

Complete engineering reference. For the quick, user-facing overview see **[README.md](README.md)**.

## Contents

- [Compatibility](#compatibility)
- [Loading & precedence](#loading--precedence)
- [Tools reference](#tools-reference)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Execution internals](#execution-internals)
- [Autodiscovery internals](#autodiscovery-internals)
- [Security](#security)
- [Verification log](#verification-log)
- [Development](#development)
- [Files](#files)

## Compatibility

Throughout this documentation, **V1** means OpenCode 1.x and **V2** means OpenCode 2.x.

| OpenCode | Entry called | Status |
|----------|--------------|--------|
| 2.x (2.0.15–2.0.16) | `setup()` | ✅ tested live |
| 1.18.29 – 1.18.32 | `server()` | ✅ tested live (1.18.32) |
| 1.18.0 – 1.18.28 | — | ❌ pin `opencode-subagent-delegate@1.2.5` |

- `package.json` declares `"engines": { "opencode": ">=1.18.29" }`. Older 1.x releases refuse the plugin with a clear message instead of failing silently.
- V1 object entrypoints (a default export with a `server()` method) landed in OpenCode **1.18.29**. The dual entrypoint follows the official pattern from the V2 migration guide: *"A package can temporarily expose both implementations from one default export. V1 calls `server()` and V2 calls `setup()`."*
- The dual shape was verified two ways:
  - **Source**: OpenCode v1.18.32 `plugin/shared.ts` → `readV1Plugin()` detects a default object with an `id`/`server`, requires `server` to be a function, and ignores extra keys such as `setup`.
  - **Runtime**: loaded on v1.18.32 and v2.0.15–2.0.16 (both executed tools end-to-end).

### Execution surfaces

| | V1 | V2 |
|---|---|---|
| Child session | `client.session.create({ body: { parentID, title } })` — parented | `ctx.session.create({ title, agent?, model? })` — no `parentID` in the create input |
| Prompt | `client.session.prompt({ path: { id }, body: { model, parts } })` | `ctx.session.prompt({ sessionID, text })` |
| Completion | SDK prompt blocks until done | `session.wait()` raced with `session.get().time.idle` polling |
| Abort | `ctx.abort` → `/session/{id}/abort` | tool `signal` → `ctx.session.interrupt({ sessionID })` |
| Inline Task pane | ToolResult `metadata` + live metadata PATCH | ToolResult `metadata` only |
| System hint | `experimental.chat.system.transform` | `ctx.session.hook("context")` |
| Tools | `tool()` map + Zod schemas | `ctx.tool.transform(editor.add)` + JSON Schema |

> V2 note: `SessionCreateInput` has no `parentID` (only forks carry one), so V2 children are standalone sessions; the TUI Task pane is driven entirely by the ToolResult metadata (`sessionId`, `parentSessionId`). V2 cannot set parent linkage through the plugin API — `session.import` (which does accept `parentID`) is not exposed to plugins.

## Loading & precedence

OpenCode resolves plugins in this order, and all hooks run in sequence:

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory (`~/.config/opencode/plugins/`)
4. Project plugin directory (`.opencode/plugins/`)

Duplicate npm packages with the same name and version are loaded once.

**Tool precedence** — OpenCode's documented rule: if a plugin tool uses the same name as a built-in tool, the plugin tool takes precedence (a later registration overrides the same effective tool name). This package registers `delegate` and `discover_models` (no built-in collision) and deliberately overrides the built-in `task` with a routing-aware equivalent — on both 1.x and 2.x.

### Local drop-in (no npm)

OpenCode auto-loads every `.ts`/`.js` file directly inside `~/.config/opencode/plugins/` — **not** subdirectories. The npm package ships a multi-file layout, so a local copy needs a one-file wrapper at the plugin-dir root:

```bash
mkdir -p ~/.config/opencode/plugins/model-router
cp index.ts v1.ts v2.ts registry.ts resolver.ts execution.ts ~/.config/opencode/plugins/model-router/
cat > ~/.config/opencode/plugins/model-router.ts <<'EOF'
export { default } from "./model-router/index.js"
EOF
```

The wrapper re-exports the dual entrypoint, so this works on both 1.x (≥ 1.18.29) and 2.x. No config edit needed — restart OpenCode.

> ⚠️ **Don't use both install methods at once.** A local copy *plus* an npm config entry registers `task` / `delegate` / `discover_models` twice. Pick one.

## Tools reference

### `discover_models(query?, free?)`

Substring search over model `id`, `name`, and `family` (case-insensitive). Returns at most 20 matches with qualified ids, names, family, and context size. No prices are ever shown.

```
discover_models("glm-5.3-flash")
→ Found 5 of 5 matching "glm-5.3-flash":
  - zai-coding-plan/glm-5.3-flash — GLM-5.3-Flash ctx:1000000 · free · also: llmgateway, opencode-go, opencode
  - nvidia/z-ai/glm-5.3-flash — GLM-5.3-Flash ctx:1000000 · free
  ...
```

`free: true` lists only free models, grouped by provider so rate-limit and reliability trade-offs stay visible:

```
discover_models(free=true)
→ Free models — 138 across 8 providers:
  - nvidia (99): z-ai/glm-5.3-flash, deepseek-ai/deepseek-v4-flash, …
  - opencode (7): big-pickle, mimo-v2.6-flash-free, …
  ...
```

Free detection inspects **both sources together** whenever the runtime catalog is available:

1. **Runtime model info** (V2 `ctx.model.list()`; V1 `client.config.providers()`) — every reported cost tier is zero, or its own id/name marks free.
2. **`opencode.json` entries** (`provider.<id>.models`) — the config name/id marks free, or a config-declared cost is zero.

`free = primary cost ∪ primary naming ∪ config naming ∪ config cost`. Correlation is exact and same-provider only: a config entry joins a primary entry when both the providerID and the model id agree (config `id`/key equals the primary modelID, or the raw config key does). Unrelated models are never combined; config-only models are appended.

`fetchFromFilesystem` is the fallback path for when the primary source itself fails or returns nothing — not the free-detection path. Models with no cost data and no free signal in either source are excluded. Normal results annotate other providers carrying the same model (free siblings are marked); the free listing groups everything by provider.

If a query returns zero results, the registry is force-refreshed once (picks up newly authenticated providers) before giving up.

### `task(description, prompt, subagent_type?, model?, variant?)` — native override

Overrides OpenCode's built-in `task` tool to add **model routing** while keeping the Task pane clickable inline:

- **No `model` passed** → native behavior: the subagent inherits your chat's model.
- **`model` passed** → the subagent runs on that model instead, chosen from *any* connected provider.
- `variant` → reasoning effort (e.g. `high`, `max`); `subagent_type` → the agent to run (`build`, `plan`, or any configured agent). Omit `subagent_type` to inherit the current agent.
- The child session is titled from `description`, which skips an auto-title model call.

Because the tool keeps the native `task` name, the TUI mounts its real Task renderer — the subagent pane is **clickable inside your parent chat** (navigation, duration, tool count), whether or not you routed it to another model.

### `delegate(model, task, agent?, variant?)`

Runs `task` on the target model in a child session and returns the output.

```
delegate(model="google/gemini-2.5-flash", task="Summarize this diff: ...")
delegate(model="opencode/mimo-v2.5-free", task="...", agent="plan", variant="high")
```

| Arg | Required | Description |
|-----|----------|-------------|
| `model` | ✅ | Short or qualified `provider/model` id |
| `task` | ✅ | Prompt to run on the target model |
| `agent` | — | Run the child as a named agent (`build`, `plan`, or a configured subagent) |
| `variant` | — | Model reasoning variant / effort for the child run (`low`, `high`, `max`, ...) |

Resolution rules:

| Input | Behavior |
|-------|----------|
| `"google/gemini-2.5-flash"` | Exact `provider/model` lookup — unambiguous |
| `"openrouter/google/gemini-3.7"` | Provider `openrouter`, model id `google/gemini-3.7` |
| `"gemini-3.7"` (1 match) | Resolves directly |
| `"gemini-3.7"` (2+ matches) | Returns the match list; the agent shows it and asks the user which provider to use, then retries with their choice |
| `"gemini-3.7"` (0 matches) | Error with a `discover_models` suggestion |

On short-name misses, the registry is force-refreshed once before failing (handles fresh auth). Provider errors surface as readable envelopes: `ModelUnavailableError` suggests another provider for the same family; auth errors point at the credential store.

## Routing policy (system hint)

The plugin injects a short hint into the agent loop's system prompt — identically on **both** paths: V1 via `experimental.chat.system.transform`, V2 via `ctx.session.hook("context")`. The hint never contains the model catalog; it exists so the model knows the tools exist and how to route:

1. **No model requested** → call `task` without `model`; the subagent inherits the current session's model. The agent never routes to another model on its own. (V2 implements inheritance explicitly: the parent session's model is read via `session.get` and passed to `session.create`.)
2. **A model class is requested** (free / cheap / fast / strong / local) → `discover_models` first; for free call `discover_models(free=true)` (zero-cost models per provider — Zen `*-free`, Nvidia, plan-included); prefer `*-free` (OpenCode Zen) for the most generous limits — Nvidia's free tier is rate-limited.
3. **A specific model is named** → resolve it. If the same model exists on several providers (or the id is ambiguous), show the matches and **ask the user** which one to use — never choose a provider silently. Route to the user's choice; unknown ids are re-discovered first.
4. Never guess from price; keep descriptions to 3–5 words.

Set `hintInSystemPrompt: false` to disable the hint entirely.

## Configuration

All options are optional.

**OpenCode 1.x** — pass them as the second element of the plugin tuple:

```json
{
  "plugin": [
    ["opencode-subagent-delegate", {
      "preferredProviders": { "gemini": "google", "claude": "opencode" },
      "registryTtlMs": 300000,
      "hintInSystemPrompt": true
    }]
  ]
}
```

**OpenCode 2.x** — use the object form; options arrive via `ctx.options`:

```json
{
  "plugins": [
    {
      "package": "opencode-subagent-delegate",
      "options": {
        "preferredProviders": { "gemini": "google", "claude": "opencode" },
        "registryTtlMs": 300000,
        "hintInSystemPrompt": true
      }
    }
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `preferredProviders` | `{}` | Map of short-name/family → providerID. Makes an ambiguous short name deterministic **only when exactly one** model from the preferred provider matches — otherwise it stays ambiguous. |
| `registryTtlMs` | `300000` | Registry cache TTL in milliseconds. |
| `hintInSystemPrompt` | `true` | Inject a short hint that the delegation tools exist. No catalog is ever included. |

## Architecture

One package, two implementations, one default export:

```text
index.ts  →  export default { id, setup: v2.setup, server: v1.ModelRouterPlugin }
                │                                  │
                │ V2 (2.x)                         │ V1 (≥ 1.18.29)
                ▼                                  ▼
             v2.ts                    v1.ts  (+ registry.ts / resolver.ts / execution.ts)
```

- **`v2.ts`** — V2 plugin API, self-contained:
  - tools via `ctx.tool.transform((editor) => editor.add({ name, description, input: <JSON Schema>, execute }))`
  - system hint via `ctx.session.hook("context", (event) => event.system.push({ type: "text", text }))`
  - catalog via `ctx.model.list()` with filesystem fallback
  - child runs via `ctx.session.*` with progress reporting and a ceiling-guarded wait
- **`v1.ts` + support modules** — V1 plugin API: one factory receiving `{ project, client, $, directory, worktree }`, returning hooks and tool definitions.
- **`listing.ts`** — shared, dependency-free listing helpers: the `ModelEntry` shape, free detection (cost tiers + naming fallback), and the `discover_models` renderers. Both implementations use it, so V1 and V2 output cannot drift.
- **`config-models.ts`** — reads `opencode.json` custom provider models and merges their free signals into primary entries (exact, same-provider matching). Shared by V1 and V2.

| V1 component | Plugin API used | Role |
|--------------|----------------|------|
| `Registry` | SDK client | Merged model catalog with TTL cache and scored substring search |
| `Resolver` | — (pure) | `(providerID, modelID)` resolution, ambiguity lists, `preferredProviders` tie-breaks |
| `SessionExecutionAdapter` | `client.session.create/prompt/abort/message` | Parented child-session spawn, live metadata PATCH, abort wiring |
| `tool: discover_models` | `tool()` helper + Zod schema | On-demand catalog search (≤20 rows, no prices) |
| `tool: delegate` / `tool: task` | `tool()` helper + Zod schema | Cross-model subagent execution with inline TUI rendering |
| System hint | `experimental.chat.system.transform` | Short tool availability note; the catalog itself is never injected |

## Execution internals

### V1 flow

```
client.session.create({ body: { parentID, title } })   → child session nested under your chat
client.session.prompt({ path: { id }, body: { model, parts } })  → blocks until the child completes
```

- The TUI Task renderer keys child-session sync, clickable navigation, and duration off `metadata.sessionId` on the tool result. While the child runs, the tool part's metadata is PATCHed directly (`client._client.patch`) so the pane goes live immediately.
- Output is wrapped in a `<task id="..." state="completed">` XML envelope, matching the built-in task tool.
- `ctx.abort` is wired to the child's own `/session/{id}/abort`, so interrupting your chat stops the child instead of leaking a live run.

### V2 flow

```
ctx.session.create({ model, agent?, title })  → child session (standalone; no parentID available)
ctx.session.prompt({ sessionID, text })       → admit the task
wait: session.wait() raced with polling session.get().time.idle
ctx.session.context({ sessionID })            → read the final assistant text
```

Robustness behaviors, all learned from live testing:

- **Progress reporting** — while a child runs, the tool emits `subagent running Ns` updates (≥10 s apart) so a long delegation never looks hung.
- **Wait hardening** — `session.wait()` is event-based; a missed idle event stalls it. The plugin races it against `session.get().time.idle` polling and takes whichever reports completion first.
- **Hard ceiling** — 30 minutes per child run. On expiry the child is interrupted and the tool returns a clear error instead of hanging forever.
- **Abort wiring** — the tool's abort signal calls `ctx.session.interrupt({ sessionID })` on the child.
- **Derived titles** — `delegate` titles the child from the task text (48 chars), skipping an auto-title model call per delegation.
- **Result shape** — the final assistant text is returned with ToolResult `metadata: { sessionId, parentSessionId, model? }`.

### Provider concurrency (important, not a bug)

Free/throttled providers commonly allow only one in-flight request. When two delegations hit the same such provider concurrently, the second request queues — observed **3–150 s** before it starts (both eventually succeed). The plugin reports progress while waiting and enforces the ceiling. Spread parallel delegations across different providers for predictable latency.

## Autodiscovery internals

No provider registration, no model lists. The registry mirrors OpenCode's own provider layer — the same one your `/connect` command and `provider(s)` config feed:

1. **Live merged catalog** (V1: `client.config.providers()` / `client.provider.list()`; V2: `ctx.model.list()`) — covers everything OpenCode resolves: `/connect`-authenticated providers, Models.dev catalog entries, OpenCode Zen and Go.
2. **Filesystem fallback** — reads `~/.config/opencode/opencode.json` `provider.models` (authoritative for custom gateways: internal endpoints, Ollama, LM Studio, llama.cpp) plus the provider cache filtered to `/connect`-authenticated providers (`auth.json`).

If a query returns zero results, the registry force-refreshes once — a provider you authenticated mid-session becomes discoverable without restarting. Unknown or renamed ids fall back to the server's own suggestion list, and the orchestrating model self-corrects via `discover_models`.

Auth flows out; secrets never do: keys are read internally to *filter* the catalog to what you can actually use, and are never returned to the LLM.

## Security

- `auth.json` is never logged.
- Provider API keys are read internally but never returned to the LLM.
- Registry entries expose only `providerID`, `modelID`, `name`, `family`, `context`, `releaseDate`.

## Verification log

**V1 (OpenCode 1.18.x)** — real runs (`opencode run --format json`), asserted at the data layer:

- ✅ Plugin auto-loads from `~/.config/opencode/plugins/` and via npm config
- ✅ `discover_models` returns qualified ids the resolver accepts back
- ✅ Ambiguous/unknown short names return the match list; the model self-corrects
- ✅ Child sessions are created with `parentID` = the invoking session
- ✅ Tool results carry `metadata.sessionId` / `parentSessionId` for inline Task-pane rendering
- ✅ Provider errors (403, model-not-found) return clean task-shaped error envelopes
- ✅ `agent` and `variant` args reach the child run
- ✅ Structured logging via `client.app.log`

**V1 dual-entrypoint (1.18.32)** — live run of this repo as a path plugin:

- ✅ `readV1Plugin` detects the default object (`id` + `server()`) and calls `server()`
- ✅ `discover_models("mimo")` → 20 of 24 matches from the live v1 catalog
- ✅ `delegate(model="opencode/mimo-v2.6-flash-free", task="Reply with exactly: PONG")` → `PONG`
- ✅ Same dual-source free detection on V1 (`client.config.providers()` + `opencode.json`); the V1 SDK exposes full cost data (zero-cost tiers for free models)

**V2 (OpenCode 2.0.15–2.0.16)** — live local drop-in of this repo:

- ✅ Dual entrypoint loads (`{ id, setup, server }`) — V2 runs `setup()`, V1 object detection is ignored
- ✅ Tools register through the V2 tool editor (`editor.add`) — `task`, `delegate`, `discover_models` all live
- ✅ `discover_models` returns the live merged catalog (`ctx.model.list()` + filesystem fallback)
- ✅ `delegate` and `task` run end-to-end: `session.create → prompt → wait → context`, child id returned in ToolResult `metadata`
- ✅ Concurrent delegations both complete; the second request queues on the provider side and the tool reports progress instead of appearing hung
- ✅ Abort signal wired to `session.interrupt` on the child
- ✅ Routing policy verified live: no model → the child inherits the session model; `"free"` class → discovered and routed to a `*-free` model; named unique model → routed directly (including an Nvidia free-tier model); named multi-provider model (`glm-5.3-flash`, 5 providers) → the agent presents the matches and **asks the user** (no child session until a choice is made); follow-up choice → executed on the chosen provider
- ✅ `discover_models(free=true)` lists zero-cost models grouped by provider; normal results annotate multi-provider models with free siblings marked
- ✅ Dual-source free detection: a config-only provider model (no cost data, name marks free) is detected through `opencode.json` while the runtime catalog is live

## Development

```bash
npm install          # dev tooling: typescript, @opencode-ai/plugin 1.4.9, @opencode-ai/sdk 1.4.9
npm test             # unit tests for the shared listing helpers (Node runs TS directly)
npm run typecheck    # tsc --noEmit (strict, no emit)
npm pack --dry-run   # inspect the publish tarball
npm publish          # release (requires npm auth)
```

Notes:

- The package ships **raw TypeScript** — OpenCode executes it directly (Bun), there is no build step.
- `@opencode-ai/sdk` is pinned to exactly `1.4.9` in devDependencies so the typechecker sees a single SDK copy (a hoisted 1.18.x copy conflicts with the one nested under `@opencode-ai/plugin`).
- `tsconfig.json` covers the whole repo; keep the typecheck clean before releasing.
- Releasing: bump `version` in `package.json`, update the changelog in README, commit, tag (`vX.Y.Z`), push, `npm publish`.

## Files

- `index.ts` — dual entrypoint: `{ id, setup, server }`.
- `v2.ts` — OpenCode 2.x implementation (self-contained).
- `v1.ts` — OpenCode 1.x implementation entry: tools + system hint.
- `registry.ts` — merged catalog, TTL cache, scored search (V1).
- `resolver.ts` — `provider/model` parsing, `preferredProviders`, explicit ambiguity (V1).
- `execution.ts` — `SessionExecutionAdapter` + inline-rendering helpers (V1).
- `listing.ts` — shared entry shape, free detection, and listing renderers (pure; used by V1 and V2).
- `config-models.ts` — opencode.json model reader + config↔catalog signal merge (shared).
- `test/listing.test.ts` — unit tests for the shared helpers (`npm test`).
- `test/config-models.test.ts` — unit tests for the config merge + reader (`npm test`).
- `tsconfig.json` — strict typecheck config.
- `README.md` — user-facing overview. This file — engineering reference.
