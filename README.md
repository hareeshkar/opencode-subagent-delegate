# opencode-subagent-delegate

Plug-and-play [OpenCode](https://opencode.ai) plugin for custom subagent model allocation — **V1 contract**: `delegate(model, task)` + `discover_models(query?)`.

Run any task on any model available to your OpenCode install, per call, without restarting OpenCode or hardcoding `model:` in every agent definition.

## Why

- **True subagents, inline**: `delegate` spawns a child session **parented to your current chat** — the TUI renders it as a live Task pane under the tool call (clickable navigation, duration, tool count), not as a stray standalone session.
- **On-demand discovery**: the LLM calls `discover_models("gemini")` and sees *only* the matching results (capped at 20), never the whole catalog. Your context stays lean.
- **Explicit execution**: `delegate(model="google/gemini-2.5-flash", task="...")` — execution identity is always `(providerID, modelID)`. Short names matching 2+ models return an ambiguity list; the LLM retries with a qualified id. No guessing.
- **No pricing heuristics**: price never enters the resolver. If you want cost routing, state it explicitly via `preferredProviders`.
- **Registry never becomes context**: the system prompt only says *tools exist and what they're for* — it never contains the model catalog.
- **Clean failures**: provider 403s, model removals, and auth errors surface as readable error envelopes — the failed task stays clickable and keeps its model metadata for retry.

## Install

No global npm install, no build step — OpenCode fetches and runs the plugin itself. You only edit your `opencode.json`:

**Global** (all projects) — `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-subagent-delegate"]
}
```

**Per-project** — same snippet in an `opencode.json` at your project root.

Then **restart OpenCode**. At startup, OpenCode's Bun runtime resolves the package, installs it, and caches it under `~/.cache/opencode/node_modules/` — TypeScript source is executed directly, so nothing to compile.

**Verify**: in any session, ask the model to call `discover_models("...")` — if the tool responds, the plugin is live.

Pin a version if you want reproducibility: `"opencode-subagent-delegate@1.0.1"`.

<details>
<summary>Editor type hints (optional)</summary>

Running `npm install opencode-subagent-delegate` inside a package.json project only helps your editor resolve types when developing against the plugin API — OpenCode itself never loads from there. Installing is not part of the plugin setup.

</details>

### Local drop-in (no npm)

OpenCode auto-loads every `.ts`/`.js` file directly inside `~/.config/opencode/plugins/` — **not** subdirectories. The npm package ships a multi-file layout, so a local copy needs a one-file wrapper at the plugin-dir root:

```bash
mkdir -p ~/.config/opencode/plugins/model-router
cp index.ts registry.ts resolver.ts execution.ts ~/.config/opencode/plugins/model-router/
cat > ~/.config/opencode/plugins/model-router.ts <<'EOF'
export { ModelRouterPlugin as default } from "./model-router/index.js"
EOF
```

No config edit needed — restart OpenCode.

> ⚠️ **Don't use both install methods at once.** OpenCode loads local plugins and npm plugins separately even with similar names — a local copy *plus* the npm config entry registers `delegate` / `discover_models` twice. Pick one.

### How it loads

OpenCode resolves plugins in this order, and all hooks run in sequence:

1. Global config (`~/.config/opencode/opencode.json`)
2. Project config (`opencode.json`)
3. Global plugin directory (`~/.config/opencode/plugins/`)
4. Project plugin directory (`.opencode/plugins/`)

Duplicate npm packages with the same name and version are loaded once.

### Tool precedence

OpenCode's documented rule: **if a plugin tool uses the same name as a built-in tool, the plugin tool takes precedence.** `opencode-subagent-delegate` only registers `delegate` and `discover_models` (no built-in collision), so it composes cleanly with task-override plugins.

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

All options are optional and passed as the second element of the plugin tuple:

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

| Option | Default | Description |
|--------|---------|-------------|
| `preferredProviders` | `{}` | Map of short-name/family → providerID. Makes an ambiguous short name deterministic **only when exactly one** model from the preferred provider matches — otherwise stays ambiguous. |
| `registryTtlMs` | `300000` | Registry cache TTL in milliseconds. |
| `hintInSystemPrompt` | `true` | Inject a ~4-line hint that the delegation tools exist. No catalog is ever included. |

## Model catalog sources

The registry merges, in order of preference:

1. **SDK merged catalog** (`client.config.providers()` / `client.provider.list()`) — covers `opencode.json` + `auth.json` + Zen gateway.
2. **Filesystem fallback** — reads `~/.config/opencode/opencode.json` (authoritative for custom providers) plus `~/.cache/opencode/models.json` filtered to providers present in `~/.local/share/opencode/auth.json`.

This means custom providers you define in config (e.g. an internal gateway) are discoverable alongside everything OpenCode knows natively.

> **Note:** the filesystem merge can briefly surface ids the server no longer resolves (e.g. a model renamed upstream while the cache is stale). In that case `delegate` returns the server's own suggestion list, and the orchestrating model can re-resolve via `discover_models` — tested and self-correcting.

## Verified

Tested against OpenCode 1.18.26 with real runs (`opencode run --format json`), then asserted at the data layer:

- ✅ Plugin auto-loads from `~/.config/opencode/plugins/` and via npm config
- ✅ `discover_models` returns qualified ids the resolver accepts back
- ✅ Ambiguous/unknown short names return the match list; the model self-corrects with a qualified id
- ✅ Child sessions are created with `parentID` = the invoking session (confirmed in server logs)
- ✅ Tool results carry `metadata.sessionId` / `parentSessionId` for inline Task-pane rendering
- ✅ Provider errors (403, model-not-found) return clean task-shaped error envelopes
- ✅ `agent` arg reaches the child run (assistant message record shows `agent: plan`)
- ✅ `variant` arg reaches the child run (assistant message record shows `variant: high`)
- ✅ Structured logging via `client.app.log` — `delegate started/completed` with duration in the opencode log

## Changelog

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

Built and tested against OpenCode 1.18.x / `@opencode-ai/plugin` 1.4.9 / SDK 1.4.9. Execution uses the v1 client surface (`session.create` with `body.parentID`, `session.prompt` with `path.id`) — the shapes the plugin receives at runtime.

## Architecture

A standard OpenCode plugin module — one factory function receiving `{ project, client, $, directory, worktree }`, returning hooks and tool definitions:

| Component | Plugin API used | Role |
|-----------|----------------|------|
| `Registry` | SDK client | Merged model catalog with TTL cache and scored substring search |
| `Resolver` | — (pure) | `(providerID, modelID)` resolution, ambiguity lists, `preferredProviders` tie-breaks |
| `SessionExecutionAdapter` | `client.session.create/prompt/abort/message` | Parented child-session spawn, live metadata PATCH, abort wiring |
| `tool: discover_models` | `tool()` helper + Zod schema | On-demand catalog search (≤20 rows, no prices) |
| `tool: delegate` | `tool()` helper + Zod schema | Cross-model subagent execution with inline TUI rendering |
| System hint | `experimental.chat.system.transform` | ~4-line tool availability note; the catalog itself is never injected |

Types come from `@opencode-ai/plugin`; `@opencode-ai/sdk` is a peer dependency resolved against OpenCode's own runtime — the published package ships TypeScript source that Bun executes directly.

## Files

- `index.ts` — plugin entry: tools + system hint.
- `registry.ts` — merged catalog, TTL cache, scored search.
- `resolver.ts` — `provider/model` parsing, `preferredProviders`, explicit ambiguity.
- `execution.ts` — `SessionExecutionAdapter` + inline-rendering helpers.

## License

MIT
