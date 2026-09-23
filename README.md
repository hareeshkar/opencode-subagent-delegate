# opencode-subagent-delegate

[![npm version](https://img.shields.io/npm/v/opencode-subagent-delegate.svg)](https://www.npmjs.com/package/opencode-subagent-delegate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/hareeshkar/opencode-subagent-delegate/blob/main/LICENSE)
[![OpenCode 1.18.29+ / 2.x](https://img.shields.io/badge/OpenCode-1.18.29%2B%20%7C%202.x-5C2D91)](https://opencode.ai/docs/plugins)

> **You've connected a fleet of providers. Your subagents still run on one model.**
> This plugin makes the whole fleet callable — as inline, clickable subagents, one config line, zero model lists to maintain.

[OpenCode](https://opencode.ai) connects you to **75+ LLM providers** — Anthropic, OpenAI, Google, DeepSeek, Moonshot, MiniMax, NVIDIA, GitHub Copilot, OpenRouter, local models via Ollama/LM Studio — plus [OpenCode Zen](https://opencode.ai/docs/zen) and Go, and any custom gateway you define in config. Every key you add with the `/connect` command, every custom provider in `opencode.json` — that's your fleet.

But the fleet is **static**. The `/models` picker drives one primary model; agent definitions hardcode theirs. Want a second opinion from a different provider mid-chat? Edit config. Restart. Repeat.

**opencode-subagent-delegate turns the fleet into tools:**

```
discover_models("kimi")
→ every Kimi variant across all your connected providers, in one call

delegate(model="moonshotai/kimi-k2.7", task="review this diff", agent="plan", variant="high")
→ runs INLINE in your current chat as a clickable subagent
```

## Why this plugin exists

- **Your `/connect` fleet, autodiscovered** — the registry merges everything OpenCode already knows: providers authenticated via `/connect`, custom providers from `opencode.json` (internal gateways, Ollama, LM Studio, llama.cpp), Zen and Go, and the Models.dev catalog. Register nothing, list nothing. **Connect a provider → it's delegable.**
- **Any model, any agent, any reasoning variant — per call.** Draft with a free Zen model, review with a frontier model, keep secrets on a local Ollama model — all in one conversation, all as subagents.
- **True subagents, inline**: `delegate` spawns a child session **parented to your current chat** — the TUI renders it as a live Task pane under the tool call (clickable navigation, duration, tool count), not as a stray standalone session.
- **On-demand discovery**: the LLM calls `discover_models("gemini")` and sees *only* the matching results (capped at 20), never the whole catalog. Your context stays lean.
- **Explicit execution**: execution identity is always `(providerID, modelID)`. Short names matching 2+ models return an ambiguity list; the LLM retries with a qualified id. No guessing.
- **No pricing heuristics**: price never enters the resolver. If you want cost routing, state it explicitly via `preferredProviders`.
- **Registry never becomes context**: the system prompt only says *tools exist and what they're for* — it never contains the model catalog.
- **Clean failures**: provider 403s, model removals, and auth errors surface as readable error envelopes — the failed task stays clickable and keeps its model metadata for retry.

## A session with the fleet

```
You: Draft the migration script, then get a strong model to review it.

LLM: delegate(model="opencode/mimo-v2.5-free", task="draft migration script for ...")
     → subagent runs inline, draft lands in your chat

LLM: delegate(model="anthropic/claude-sonnet-4-5", task="review this migration script: ...",
              agent="plan", variant="high")
     → second subagent, frontier model, high reasoning — also inline

You: click either Task pane to inspect the full child session.
```

One conversation, three providers, zero config edits, zero restarts.

## Install

No global npm install, no build step — OpenCode fetches and runs the plugin itself. You only edit your `opencode.json`.

**OpenCode 2.x** — the config key is `plugins`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-subagent-delegate"]
}
```

**OpenCode 1.x** — the config key is `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-subagent-delegate"]
}
```

Place it in the global config (`~/.config/opencode/opencode.json`, all projects) or in an `opencode.json` at your project root.

Then **restart OpenCode**. At startup OpenCode resolves the package, installs it (1.x: `~/.cache/opencode/node_modules/`, 2.x: `~/.cache/opencode/npm/`), and runs the TypeScript source directly — nothing to compile.

**Verify**: in any session, ask the model to call `discover_models("...")` — if the tool responds, the plugin is live.

Pin a version for reproducibility: `"opencode-subagent-delegate@1.3.0"`.

<details>
<summary>Editor type hints (optional)</summary>

Running `npm install opencode-subagent-delegate` inside a package.json project only helps your editor resolve types when developing against the plugin API — OpenCode itself never loads from there. Installing is not part of the plugin setup.

</details>

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

> ⚠️ **Don't use both install methods at once.** OpenCode loads local plugins and npm plugins separately even with similar names — a local copy *plus* the npm config entry registers `delegate` / `discover_models` twice. Pick one.

### How it loads

OpenCode resolves plugins in this order, and all hooks run in sequence:

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory (`~/.config/opencode/plugins/`)
4. Project plugin directory (`.opencode/plugins/`)

Duplicate npm packages with the same name and version are loaded once.

### Tool precedence

OpenCode's documented rule: **if a plugin tool uses the same name as a built-in tool, the plugin tool takes precedence** (a later registration overrides the same effective tool name). `opencode-subagent-delegate` registers `delegate` and `discover_models` (no built-in collision) and deliberately overrides the built-in `task` with a routing-aware equivalent — on both 1.x and 2.x.

## Tools

### `discover_models(query?)`

Substring search over model `id`, `name`, and `family` (case-insensitive). Returns at most 20 matches with qualified ids, names, family, and context size — no prices.

```
discover_models("gemini")
→ Found 3 of 42 matching "gemini":
  - google/gemini-2.5-flash — Gemini 2.5 Flash ctx:1048576
  ...
Use delegate(model="provider/model", task="...") with one of the above qualified ids.
```

If a query returns zero results, the registry is force-refreshed once (picks up newly authenticated providers) before giving up.

### `task(description, prompt, subagent_type?, model?, variant?)` — native override

Overrides OpenCode's built-in `task` tool (plugin tools take precedence — documented rule) to add **model routing** while keeping the Task pane clickable inline:

- **No `model` passed** → native behavior: the subagent inherits your chat's model.
- **`model` passed** → the subagent runs on that model instead, chosen from *any* connected provider.
- `variant` → reasoning effort (e.g. `high`, `max`); `subagent_type` → the agent to run (`general`, `plan`, or any configured agent).

Because the tool keeps the native `task` name, the TUI mounts its real Task renderer — the subagent pane is **clickable inside your parent chat** (navigation, duration, tool count), whether or not you routed it to another model.

### `delegate(model, task, agent?, variant?)`

Runs `task` on the target model in a parented child session and returns the output.

```
delegate(model="google/gemini-2.5-flash", task="Summarize this diff: ...")
delegate(model="opencode/mimo-v2.5-free", task="...", agent="plan", variant="high")
```

| Arg | Required | Description |
|-----|----------|-------------|
| `model` | ✅ | Short or qualified `provider/model` id |
| `task` | ✅ | Prompt to run on the target model |
| `agent` | — | Run the child as a named agent (`build`, `plan`, or a configured subagent) — real subagent allocation |
| `variant` | — | Model reasoning variant / effort for the child run (`low`, `high`, `max`, ...) |

Resolution rules:

| Input | Behavior |
|-------|----------|
| `"google/gemini-2.5-flash"` | Exact `provider/model` lookup — unambiguous |
| `"openrouter/google/gemini-3.7"` | Provider `openrouter`, model id `google/gemini-3.7` |
| `"gemini-3.7"` (1 match) | Resolves directly |
| `"gemini-3.7"` (2+ matches) | Returns ambiguity list — retry with qualified id |
| `"gemini-3.7"` (0 matches) | Error with a `discover_models` suggestion |

On short-name misses, the registry is force-refreshed once before failing (handles fresh auth).

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
| `preferredProviders` | `{}` | Map of short-name/family → providerID. Makes an ambiguous short name deterministic **only when exactly one** model from the preferred provider matches — otherwise stays ambiguous. |
| `registryTtlMs` | `300000` | Registry cache TTL in milliseconds. |
| `hintInSystemPrompt` | `true` | Inject a ~4-line hint that the delegation tools exist. No catalog is ever included. |

## Autodiscovery internals

No provider registration, no model lists. The registry mirrors OpenCode's own provider layer — the same one your `/connect` command and `provider` config feed:

1. **Live merged catalog** (V1: `client.config.providers()` / `client.provider.list()`; V2: `ctx.model.list()`) — covers everything OpenCode resolves: `/connect`-authenticated providers (`~/.local/share/opencode/auth.json`), Models.dev catalog entries, OpenCode Zen and Go.
2. **Filesystem fallback** — reads `~/.config/opencode/opencode.json` `provider.models` (authoritative for custom gateways: internal endpoints, Ollama, LM Studio, llama.cpp) plus the provider cache filtered to `/connect`-authenticated providers.

If a query returns zero results, the registry force-refreshes once — a provider you authenticated mid-session becomes discoverable without restarting. Unknown or renamed ids fall back to the server's own suggestion list, and the orchestrating model self-corrects via `discover_models` (tested and self-correcting).

Auth flows out; secrets never do: keys are read internally to *filter* the catalog to what you can actually use, and are never returned to the LLM.

## Verified

**V1 (OpenCode 1.18.x)** — real runs (`opencode run --format json`), then asserted at the data layer:

- ✅ Plugin auto-loads from `~/.config/opencode/plugins/` and via npm config
- ✅ `discover_models` returns qualified ids the resolver accepts back
- ✅ Ambiguous/unknown short names return the match list; the model self-corrects with a qualified id
- ✅ Child sessions are created with `parentID` = the invoking session (confirmed in server logs)
- ✅ Tool results carry `metadata.sessionId` / `parentSessionId` for inline Task-pane rendering
- ✅ Provider errors (403, model-not-found) return clean task-shaped error envelopes
- ✅ `agent` arg reaches the child run (assistant message record shows `agent: plan`)
- ✅ `variant` arg reaches the child run (assistant message record shows `variant: high`)
- ✅ Structured logging via `client.app.log` — `delegate started/completed` with duration in the opencode log

**V2 (OpenCode 2.0.15)** — live local drop-in of this repo, real runs:

- ✅ Dual entrypoint loads (`{ id, setup, server }`) — V2 runs `setup()`, the V1 object detection is ignored
- ✅ Tools register through the V2 tool editor (`editor.add`) — `task`, `delegate`, `discover_models` all live
- ✅ `discover_models` returns the live merged catalog (`ctx.model.list()` + filesystem fallback)
- ✅ `delegate` and `task` run end-to-end: `session.create → prompt → wait → context`, child id returned in ToolResult `metadata`
- ✅ Parent abort propagates — the tool signal interrupts the child (`session.interrupt`)
- ✅ Concurrent delegations both complete; the second request queues on the provider side (observed 3–150 s on a free tier) and the tool reports progress while waiting instead of appearing hung

## Changelog

**1.3.0**
- **OpenCode 2.x support — dual entrypoint.** One package serves both plugin APIs from a single default export: V2 calls `setup()`, V1 (≥ 1.18.29) calls `server()`. V2 delegation runs `session.create → prompt → wait → context`, tools register via `ctx.tool.transform`, the system hint via `ctx.session.hook("context")`, and abort is wired to `session.interrupt`.
- **Robust V2 waits** — races `session.wait()` against `time.idle` polling, reports progress while a child runs, and interrupts + reports at a 30-minute ceiling instead of hanging.
- **Derived child titles on V2** — `delegate` titles the child from the task text, skipping an extra auto-title model call per delegation.
- V1 behavior unchanged; `engines.opencode: >=1.18.29` guards the object-entrypoint requirement (older 1.x: pin `1.2.5`).

**1.2.0**
- **Native `task` tool override** — subagents now render as **clickable Task panes inline** (the TUI mounts its Task renderer only for tools named `task`; `delegate` alone rendered as a generic line). Omit `model` for native inherit-behavior, pass `model`/`variant` to route anywhere.

**1.1.0**
- `agent` and `variant` optional args on `delegate` — per-call subagent allocation and reasoning-effort control
- Stale-cache self-heal: qualified-id NotFound now triggers a registry force-refresh before failing
- Structured logging via `client.app.log()` (service `opencode-subagent-delegate`, best-effort)

**1.0.0**
- Initial release: `delegate` + `discover_models`, inline TUI rendering, clean error envelopes

## How execution works

`delegate` spawns a **parented child session** and prompts it with the resolved model — the same mechanics OpenCode's native task tool uses:

```
client.session.create({ body: { parentID, title } })   → child session nested under your chat
client.session.prompt({ path: { id }, body: { model, parts } })  → blocks until the child completes
```

On OpenCode 2.x the same flow uses the plugin context:

```
ctx.session.create({ model, agent, title })   → child session
ctx.session.prompt({ sessionID, text })       → admit the task
ctx.session.wait({ sessionID })               → run to completion (polled + ceiling-guarded)
ctx.session.context({ sessionID })            → read the final assistant text
```

V2 session creation has no `parentID` (only forks carry one), so the child is a standalone session and the inline Task pane is driven by the ToolResult `metadata` (`sessionId`, `parentSessionId`). While a child runs, the tool reports progress (`subagent running Ns`); aborting the parent interrupts the child via `session.interrupt`. A delegation that exceeds the 30-minute ceiling is interrupted and reported as an error instead of hanging.

### Inline rendering in the primary chat

The TUI Task renderer keys child-session sync, clickable navigation, and duration off `metadata.sessionId` on the tool result. This plugin implements the full contract:

| Mechanism | How |
|-----------|-----|
| **Clickable child session** | Tool result returns `metadata: { sessionId, parentSessionId, model }` (camelCase — required by the renderer) |
| **Live "running" state** | While the child runs, the tool part's metadata is PATCHed directly via `client._client.patch` on `/session/{sid}/message/{mid}/part/{pid}` — `ctx.metadata()` is not bridged for plugin tools |
| **Native output envelope** | Output is wrapped in `<task id="..." state="completed">` XML, matching the built-in task tool |
| **Interrupt safety** | `ctx.abort` is wired to the child's own `/session/{id}/abort` endpoint, so interrupting your chat stops the child instead of leaking a live run |

A failed delegation still returns a task-shaped error envelope, so the failed task stays clickable and surfaces the reason (provider 403, model unavailable, auth) to the model for retry.

The `ExecutionAdapter` interface is swappable — if OpenCode ships a native per-call `Task(model)` primitive, the adapter can be swapped without touching the registry or resolver.

## Security

- `auth.json` is never logged.
- Provider API keys are read internally but never returned to the LLM.
- Registry entries expose only `providerID`, `modelID`, `name`, `family`, `context`, `releaseDate`.

## Compatibility

| OpenCode | Entry called | Status |
|----------|--------------|--------|
| 2.x (2.0.15) | `setup()` | ✅ tested |
| 1.18.29 – 1.18.32 | `server()` | ✅ object entrypoints landed in 1.18.29 |
| 1.18.0 – 1.18.28 | — | ❌ pin `opencode-subagent-delegate@1.2.5` |

`package.json` declares `"engines": { "opencode": ">=1.18.29" }`, so older 1.x releases refuse the plugin with a clear message instead of failing silently.

Execution surfaces: 1.x uses the v1 client (`session.create` with `body.parentID`, `session.prompt` with `path.id`); 2.x uses the plugin context (`ctx.session.create/prompt/wait/context/interrupt`, tools via `ctx.tool.transform`, system hint via `ctx.session.hook("context")`).

**Performance note** — concurrent delegations to the same throttled provider (typically free tiers) queue on the provider side: the first request runs immediately, the second can wait seconds to a couple of minutes before it starts. The tool reports progress while waiting and results still arrive — spread parallel delegations across different providers for predictable latency.

## Architecture

One package, two implementations, one default export:

```text
index.ts  →  export default { id, setup: v2.setup, server: v1.ModelRouterPlugin }
                │                                  │
                │ V2 (2.x)                         │ V1 (≥ 1.18.29)
                ▼                                  ▼
             v2.ts                    v1.ts  (+ registry.ts / resolver.ts / execution.ts)
```

- **`v2.ts`** — V2 plugin API, self-contained: tools via `ctx.tool.transform(editor.add)`, system hint via `ctx.session.hook("context")`, catalog via `ctx.model.list()` with filesystem fallback, child runs via `ctx.session.*` (progress + ceiling-guarded waits).
- **`v1.ts` + support modules** — V1 plugin API: one factory receiving `{ project, client, $, directory, worktree }`, returning hooks and tool definitions.

| V1 component | Plugin API used | Role |
|--------------|----------------|------|
| `Registry` | SDK client | Merged model catalog with TTL cache and scored substring search |
| `Resolver` | — (pure) | `(providerID, modelID)` resolution, ambiguity lists, `preferredProviders` tie-breaks |
| `SessionExecutionAdapter` | `client.session.create/prompt/abort/message` | Parented child-session spawn, live metadata PATCH, abort wiring |
| `tool: discover_models` | `tool()` helper + Zod schema | On-demand catalog search (≤20 rows, no prices) |
| `tool: delegate` / `tool: task` | `tool()` helper + Zod schema | Cross-model subagent execution with inline TUI rendering |
| System hint | `experimental.chat.system.transform` | ~4-line tool availability note; the catalog itself is never injected |

Types come from `@opencode-ai/plugin`; `@opencode-ai/sdk` is a peer dependency resolved against OpenCode's own runtime — the published package ships TypeScript source that Bun executes directly.

## Files

- `index.ts` — dual entrypoint: `{ id, setup, server }`.
- `v2.ts` — OpenCode 2.x implementation (self-contained).
- `v1.ts` — OpenCode 1.x implementation entry: tools + system hint.
- `registry.ts` — merged catalog, TTL cache, scored search (V1).
- `resolver.ts` — `provider/model` parsing, `preferredProviders`, explicit ambiguity (V1).
- `execution.ts` — `SessionExecutionAdapter` + inline-rendering helpers (V1).

## License

MIT
