# opencode-subagent-delegate

[![npm version](https://img.shields.io/npm/v/opencode-subagent-delegate.svg)](https://www.npmjs.com/package/opencode-subagent-delegate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/hareeshkar/opencode-subagent-delegate/blob/main/LICENSE)
[![OpenCode 2.x / 1.18.29+](https://img.shields.io/badge/OpenCode-2.x%20%7C%201.18.29%2B-5C2D91)](https://opencode.ai/docs/plugins)

> **Your OpenCode is connected to a fleet of providers. Your subagents still run on one model.**
>
> One config line turns that fleet into tools — run any subagent on any model you've already connected, right inside your current chat, as a clickable card.

```text
You:    Draft the migration script, then get a strong model to review it.

Agent:  task(model="opencode/mimo-v2.6-flash-free", task="draft the migration script…")
        → the draft appears inline as a clickable card

        delegate(model="anthropic/claude-sonnet-4-5", task="review this draft…", variant="high")
        → a second opinion from a frontier model — also inline

You:    click either card → the full subagent session opens
```

|  |  |
|---|---|
| **Works on** | OpenCode **2.x** and **1.18.29+** (V1/V2 — one package, dual entrypoint) |
| **Verified on** | 2.0.15, 2.0.16 and 1.18.32 — live runs, not just typechecks |
| **Adds** | `task` (routing-aware override), `delegate`, `discover_models` |
| **Model sources** | everything you've connected — `/connect` providers, custom gateways, Zen/Go, local Ollama / LM Studio |
| **Context cost** | a few-line hint; the catalog is fetched on demand, never injected |
| **Install** | one config line — no build step, no global install |

## Why people install it

- **Any connected model, per call.** Draft with a free model, review with a frontier model, keep secrets on a local model — all in one conversation, each as its own subagent.
- **Inline, clickable subagents.** Every delegation renders as a Task card in your current chat (the same renderer as OpenCode's built-in `task`), with navigation, duration, and tool count.
- **Free models, found properly.** Ask for a free model and the agent lists every zero-cost option *grouped by provider* — Zen `*-free`, Nvidia's free tier, plan-included models from Z.AI/MiniMax, and free signals from your own `opencode.json` entries. Rate limits differ per provider, so you see the choices.
- **No model lists to maintain.** Discovery is on demand. Connect a provider → it's delegable. Nothing to register, nothing to update.
- **Honest execution.** A delegation is always `provider/model`. Ambiguous short names return a match list and the agent **asks you which provider to use** — it never picks silently.
- **Clean failures.** Provider 403s, model removals, and auth errors come back as readable messages the agent can retry from.

## Install (2 minutes)

**OpenCode 2.x (V2)** — add to `~/.config/opencode/opencode.json` (or a project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-subagent-delegate"]
}
```

**OpenCode 1.x (V1, 1.18.29+)** — same idea, the key is `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-subagent-delegate"]
}
```

Then **restart OpenCode**. OpenCode fetches the package itself — nothing to compile.

**Verify:** ask your agent to *"call `discover_models` with query 'gemini'"*. If a list of models comes back, you're live.

## How you use it

You don't run anything yourself — you ask, and your agent picks the right tool:

| Ask like this | What happens |
|---|---|
| *"Get a second opinion from Gemini on this diff."* | `delegate(model="google/gemini-…", …)` |
| *"Draft this with a cheap model, then have a strong model review it."* | `task(…)` with a routed `model` |
| *"Use any free model to summarize this."* | `discover_models(free=true)` → routed to a zero-cost model |
| *"Which Kimi models do I have?"* | `discover_models("kimi")` — with provider annotations |

Everything shows up as a clickable card in the chat — open it to see the subagent's full session, or just read the result inline.

## FAQ

**Does it send my data anywhere new?**
No. It only uses providers you've already connected to OpenCode, with your existing credentials.

**Does it cost extra?**
Only the calls you delegate. Free models stay free, and pricing never affects routing — you choose the model explicitly (or let the agent choose by name).

**How do I use only free models?**
Ask for one — say "use a free model". The agent calls `discover_models(free=true)`, which lists zero-cost models grouped by provider: OpenCode Zen `*-free`, Nvidia's free tier, and plan-included models from subscriptions like Z.AI and MiniMax. Free status is computed from the runtime's cost data **and** your `opencode.json` entries together, so custom providers are covered too. When a free model is available on several providers, all of them are listed so you can choose — rate limits differ.

**What if a model exists on several providers?**
Then the plugin doesn't choose for you — it shows the matches and asks which provider you want, then runs the subagent on your pick. A named model always resolves to one exact `provider/model` before anything runs.

**Do I need to configure models?**
No. If OpenCode can use a model, this plugin can delegate to it. `discover_models` is how the agent finds exact ids when it's unsure.

**Which OpenCode versions are supported?**
2.x and 1.18.29+. On 1.18.0–1.18.28, pin `opencode-subagent-delegate@1.2.5` (V1-only build).

**A free model seems stuck — is it broken?**
No. Free/throttled providers typically allow one request at a time; a second concurrent delegation queues (observed 3–150 s) and then runs. The tool shows progress while waiting and gives up cleanly after 30 minutes.

**Where do my credentials live?**
In OpenCode's own credential store. The plugin reads provider/model metadata to know what's usable, and never returns keys to the model or logs.

---

## For developers

**→ Full engineering documentation: [DEVELOPERS.md](DEVELOPERS.md)** — versions, evidence, test recipes, and internals.

### Architecture

One package, two implementations, one shared pure core:

```text
index.ts  →  export default { id, setup, server }
                │                              │
                │ V2 (2.x)                     │ V1 (≥ 1.18.29)
                ▼                              ▼
             v2.ts               v1.ts (+ registry.ts / resolver.ts / execution.ts)
                │                              │
                └────────────┬─────────────────┘
                             ▼
              listing.ts  ·  config-models.ts
        (pure: entry shape, free detection, renderers, config merge)
```

- **`v2.ts`** — V2 API: tools via `ctx.tool.transform(editor.add)`, routing hint via `ctx.session.hook("context")`, catalog via `ctx.model.list()`, child runs via `ctx.session.*` with progress reporting and a hardened wait (wait race + idle polling + 30-min ceiling).
- **`v1.ts` + modules** — V1 API: one factory returning hooks and `tool()`-based definitions; parented child sessions; live metadata PATCH for the TUI.
- **`listing.ts` / `config-models.ts`** — the shared, unit-tested core. V1 and V2 render byte-identical output because both call these; runtime surfaces stay separate because the two plugin APIs genuinely differ.

### Design principles (the parts senior engineers check first)

1. **No prices, ever.** Cost data is reduced to a boolean `free` before it can reach a model. Pricing never influences routing.
2. **Explicit identity.** Execution is always `(providerID, modelID)`. Ambiguity returns facts, not guesses.
3. **The catalog never enters context.** The hint is a fixed string; discovery is a tool call.
4. **Dual entrypoint, single behaviour.** The documented migration pattern (`setup()` / `server()`), with shared pure logic so the two runtimes cannot drift.
5. **Bound everything.** ≤20 search rows, ≤6 free ids/provider, 30-minute child ceiling, progress ticks while waiting.

### What's in DEVELOPERS.md

- Compatibility matrix with the exact entrypoints called on 1.18.29+/2.x, `engines` guard, and why older 1.x pins `1.2.5`
- Tools reference: arguments, resolution algorithm, output conventions, error envelopes
- **Free detection in depth**: signal sources (runtime cost tiers, naming, `opencode.json`), the union formula, the exact same-provider matching rule, and the fallback boundary
- Routing policy: the injected hint text and both injection hooks
- Execution internals: V1 parented sessions vs the V2 `create → prompt → wait → context` flow, the measured wait behavior, abort wiring
- Registry/resolver internals, configuration reference, security model
- Testing: 26 unit checks + the live verification matrix, with reproduction recipes (including the V1 isolated-HOME recipe and its pitfalls)
- Troubleshooting: log lines, failure meanings, and known runtime differences

---

## Changelog

**1.6.0**
- **Dual-source free detection** — free status is computed from *both* the runtime catalog (cost tiers) **and** your `opencode.json` entries (name/id signals), joined by exact provider + model id. Config-only models are included; the filesystem read remains only the fallback for when the runtime catalog itself fails.
- Shared `config-models.ts` reader/merge (unit-tested) used by V1 and V2; `npm test` now runs 26 checks.

**1.5.0**
- **Real free detection + provider-aware listing** — `discover_models(free=true)` lists zero-cost models grouped by provider: reported zero-cost tiers **and** a `*-free` id/name fallback, so Nvidia's free tier and plan-included models (Z.AI, MiniMax) show up too. Results annotate models that exist on several providers, marking which of those are free. A shared, unit-tested pure helper (`listing.ts`) keeps V1 and V2 output identical.

**1.4.0**
- **Explicit routing policy** — no model requested → the subagent inherits the current model; a model *class* requested (free / cheap / fast / strong / local) → discovered first, then routed; a specific model named → routed only after resolution.
- **Ambiguous models ask you** — when the same model exists on several providers, the agent shows the matches and asks which provider to use instead of choosing silently.
- V2 inherits the invoking session's model explicitly (`session.get` → `session.create`), never relying on runtime defaults.

**1.3.0**
- **OpenCode 2.x support — dual entrypoint.** One package serves both plugin APIs from a single default export: V2 calls `setup()`, V1 (≥ 1.18.29) calls `server()`. V2 delegation runs `session.create → prompt → wait → context`, tools register via `ctx.tool.transform`, the system hint via `ctx.session.hook("context")`, abort is wired to `session.interrupt`.
- **Robust V2 waits** — races `session.wait()` against `time.idle` polling, reports progress while a child runs, and interrupts + reports at a 30-minute ceiling instead of hanging.
- **Derived child titles on V2** — `delegate` titles the child from the task text, skipping an extra auto-title model call per delegation.
- V1 behavior unchanged; `engines.opencode: >=1.18.29` guards the object-entrypoint requirement (older 1.x: pin `1.2.5`).

**1.2.0**
- **Native `task` tool override** — subagents render as **clickable Task panes inline**. Omit `model` for native inherit-behavior, pass `model`/`variant` to route anywhere.

**1.1.0**
- `agent` and `variant` optional args on `delegate` — per-call subagent allocation and reasoning-effort control
- Stale-cache self-heal: qualified-id NotFound triggers a registry force-refresh before failing
- Structured logging via `client.app.log()`

**1.0.0**
- Initial release: `delegate` + `discover_models`, inline TUI rendering, clean error envelopes

## License

MIT
