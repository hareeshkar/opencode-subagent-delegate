# opencode-subagent-delegate

[![npm version](https://img.shields.io/npm/v/opencode-subagent-delegate.svg)](https://www.npmjs.com/package/opencode-subagent-delegate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/hareeshkar/opencode-subagent-delegate/blob/main/LICENSE)
[![OpenCode 2.x / 1.18.29+](https://img.shields.io/badge/OpenCode-2.x%20%7C%201.18.29%2B-5C2D91)](https://opencode.ai/docs/plugins)

> **Your OpenCode is connected to a fleet of providers. Your subagents still run on one model.**
>
> One config line turns that fleet into tools — run any subagent on any model you've already connected, right inside your current chat, as a clickable card.

```text
You:    Draft the migration script, then get a strong model to review it.

Agent:  task(model="opencode/mimo-v2.5-free", task="draft the migration script…")
        → the draft appears inline as a clickable card

        delegate(model="anthropic/claude-sonnet-4-5", task="review this draft…", variant="high")
        → a second opinion from a frontier model — also inline

You:    click either card → the full subagent session opens
```

|  |  |
|---|---|
| **Works on** | OpenCode 2.x · 1.18.29+ (one package, dual entrypoint) |
| **Adds** | `task` (routing-aware override), `delegate`, `discover_models` |
| **Model sources** | everything you've connected — `/connect` providers, custom gateways, Zen/Go, local Ollama / LM Studio |
| **Context cost** | a few-line hint; the model catalog is fetched on demand, never injected |
| **Install** | one config line — no build step, no global install |

## Why people install it

- **Any connected model, per call.** Draft with a free model, review with a frontier model, keep secrets on a local model — all in one conversation, each as its own subagent.
- **Inline, clickable subagents.** Every delegation renders as a Task card in your current chat (the same renderer as OpenCode's built-in `task`), with navigation, duration, and tool count.
- **No model lists to maintain.** The plugin discovers your catalog on demand. Connect a provider → it's delegable. Nothing to register, nothing to update.
- **Honest execution.** A delegation is always `provider/model`. Ambiguous short names return a match list instead of guessing. Price never influences routing.
- **Clean failures.** Provider 403s, model removals, and auth errors come back as readable messages the agent can retry from — no silent dead ends.

## Install (2 minutes)

**OpenCode 2.x** — add to `~/.config/opencode/opencode.json` (or a project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-subagent-delegate"]
}
```

**OpenCode 1.x** — same idea, the key is `plugin`:

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

| Ask like this | Your agent uses |
|---|---|
| *"Get a second opinion from Gemini on this diff."* | `delegate(model="google/gemini-…", …)` |
| *"Draft this with a cheap model, then have a strong model review it."* | `task(…)` with a routed `model` |
| *"Which Kimi models do I have across providers?"* | `discover_models("kimi")` |

Everything shows up as a clickable card in the chat — open it to see the subagent's full session, or just read the result inline.

## FAQ

**Does it send my data anywhere new?**
No. It only uses providers you've already connected to OpenCode, with your existing credentials.

**Does it cost extra?**
Only the calls you delegate. Free models stay free, and pricing never affects routing — you choose the model explicitly (or let the agent choose by name).

**Do I need to configure models?**
No. If OpenCode can use a model, this plugin can delegate to it. `discover_models` is how the agent finds exact ids when it's unsure.

**Which OpenCode versions are supported?**
2.x and 1.18.29+. On 1.18.0–1.18.28, pin `opencode-subagent-delegate@1.2.5` (V1-only build).

**A free model seems stuck — is it broken?**
No. Free/throttled providers typically allow one request at a time; a second concurrent delegation queues (observed 3–150 s) and then runs. The tool shows progress while waiting and gives up cleanly after 30 minutes.

**Where do my credentials live?**
In OpenCode's own credential store. The plugin reads them to know which models are usable, and never returns keys to the model or logs.

---

## For developers

**→ Full engineering documentation: [DEVELOPERS.md](DEVELOPERS.md)**

What's inside:

- **Compatibility matrix** — exact entrypoints called on 1.18.29+/2.x, `engines` guard, why older 1.x needs `1.2.5`
- **Tools reference** — argument tables, resolution rules, ambiguity handling, error envelopes
- **Configuration** — `preferredProviders`, `registryTtlMs`, `hintInSystemPrompt` (V1 tuple + V2 object form)
- **Architecture** — the dual entrypoint (`setup()` / `server()`) and both implementations
- **Execution internals** — V1 parented child sessions vs the V2 `create → prompt → wait → context` flow, progress reporting, ceiling, abort wiring
- **Autodiscovery internals** — merged catalog sources and the filesystem fallback
- **Verification log** — everything that was tested live on 1.18.32 and 2.0.15
- **Development** — typecheck, packaging, release steps

One package, two implementations, one default export:

```text
index.ts  →  export default { id, setup: v2.setup, server: v1.ModelRouterPlugin }
                │                                  │
                │ V2 (2.x)                         │ V1 (≥ 1.18.29)
                ▼                                  ▼
             v2.ts                    v1.ts  (+ registry.ts / resolver.ts / execution.ts)
```

## Changelog

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
