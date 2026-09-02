/**
 * model-router/index.ts — Plug-and-play model router for OpenCode.
 *
 * V1 contract (tiny, static-schema, on-demand):
 *   delegate(model: string, task: string)
 *   discover_models(query?: string)
 *
 * Invariants:
 *  - Registry is owned by plugin, never injected into LLM context.
 *  - System prompt hint says tools exist + what they're for, but does NOT contain catalog.
 *  - Execution identity is always (providerID, modelID); ambiguity returns matches for explicit choice.
 *  - No prices, no pricing heuristics.
 *  - Registry source is SDK merged catalog (opencode.json + auth.json + zen gateway), not just config file.
 *
 * Drop-in: place this folder under ~/.config/opencode/plugins/model-router/ — auto-loaded.
 *   No npm publish required; for release, `npm publish` this folder with @opencode-ai/plugin as peerDep.
 *
 * Adapted for OpenCode 1.18.x / @opencode-ai/plugin 1.4.9 / SDK 1.4.9.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Registry } from "./registry.js";
import { Resolver, formatAmbiguous, formatNotFound } from "./resolver.js";
import { SessionExecutionAdapter, renderOutput } from "./execution.js";

// Plugin options shape — keep additive, backward compatible.
type PluginOptions = {
  preferredProviders?: Record<string, string>;
  registryTtlMs?: number;
  hintInSystemPrompt?: boolean;
};

// Small system hint — injected via experimental hook, no catalog.
// User wants: "Hey, this tool is available... these tools are for this."
const SYSTEM_HINT = [
  "Model delegation is available via tools (on-demand discovery, no catalog injected):",
  "- `discover_models(query?)` — search available models (optional substring filter over id/name/family). Returns at most 20 matches; use to find a model before delegating.",
  "- `delegate(model, task)` — run a task with another model. `model` may be short (e.g. \"gemini-3.7\") or qualified \"provider/model\" (e.g. \"google/gemini-2.5-flash\" or \"openrouter/google/gemini-3.7\"). If short name is ambiguous, re-call with qualified provider/model.",
  "Prefer qualified provider/model for deterministic routing. Never guess a provider from price.",
].join("\n");

export const ModelRouterPlugin: Plugin = async (input, opts) => {
  const options = (opts ?? {}) as PluginOptions;
  const preferredProviders = options.preferredProviders ?? {};
  const ttlMs = options.registryTtlMs ?? 5 * 60 * 1000;
  const hintInSystemPrompt = options.hintInSystemPrompt ?? true;

  const registry = new Registry({ client: input.client }, { ttlMs });
  const resolver = new Resolver(registry, { preferredProviders });
  const execution = new SessionExecutionAdapter({ client: input.client });

  // Best-effort eager load — warms cache without blocking startup. Failure is non-fatal.
  registry.load().catch(() => {});

  // Keep cache warm / invalidate on relevant events if emitted
  const eventHook = async ({ event }: { event: { type: string } }) => {
    if (event.type === "installation.updated" || event.type.startsWith("session.")) {
      // only invalidate on provider/auth-relevant events; session events are noisy, so just noop
    }
  };

  return {
    // Keep hook map lean — only what V1 needs. System hint is the only prompt-layer change.
    ...(hintInSystemPrompt
      ? {
          "experimental.chat.system.transform": async (
            _in: unknown,
            out: { system: string[] },
          ) => {
            // out.system is string[] per plugin types 1.4.9 — push hint if not already present
            const joined = out.system.join("\n");
            if (!joined.includes("discover_models")) {
              out.system.push(SYSTEM_HINT);
            }
          },
        }
      : {}),

    event: eventHook as unknown as Plugin extends (i: infer I) => Promise<infer H> ? H extends { event?: infer E } ? E : never : never,

    tool: {
      discover_models: tool({
        description:
          "Discover available models (on-demand). Use query to filter id/name/family (case-insensitive substring). Returns at most 20 matches without prices. Use after to call delegate() with qualified provider/model.",
        args: {
          query: tool.schema.string().optional().describe("optional substring filter over model id/name/family, e.g. 'gemini', 'claude', 'qwen'"),
        },
        async execute(args, _ctx) {
          await registry.load();
          // If query present but no results, force refresh once (new auth/provider may have appeared)
          let res = registry.search(args.query);
          if (args.query && res.total === 0) {
            await registry.load({ force: true });
            res = registry.search(args.query);
          }
          if (res.models.length === 0) {
            const allCount = registry.all().length;
            return `No models matched query "${args.query ?? ""}". Catalog has ${allCount} models. Try a broader query, e.g. discover_models("gemini").`;
          }
          // Tiny output: qualified + name + context — no prices
          const lines = res.models
            .map((m) => {
              const ctx = m.context ? ` ctx:${m.context}` : "";
              const fam = m.family ? ` family:${m.family}` : "";
              return `- ${m.qualified} — ${m.name}${fam}${ctx}`;
            })
            .join("\n");
          const header = `Found ${res.models.length} of ${res.total} matching "${args.query ?? "*"}":`;
          const footer =
            res.total > res.models.length ? `(showing top ${res.models.length} — refine query to narrow)` : "";
          return [header, lines, footer, `Use delegate(model="provider/model", task="...") with one of the above qualified ids.`]
            .filter(Boolean)
            .join("\n");
        },
      }),

      delegate: tool({
        description:
          "Delegate a task to a specific model as a parented subagent (renders inline). Model may be short ('gemini-3.7') or qualified 'provider/model' ('google/gemini-2.5-flash'). If ambiguous, returns matches to retry with qualified id. Optional: agent (run the child as a named agent, e.g. 'plan') and variant (model reasoning variant, e.g. 'high' or 'max').",
        args: {
          model: tool.schema
            .string()
            .describe("model id — short name or qualified provider/model (preferred, e.g. 'google/gemini-2.5-flash')"),
          task: tool.schema.string().describe("prompt/task to run with the target model"),
          agent: tool.schema
            .string()
            .optional()
            .describe("optional agent for the child run (e.g. 'build', 'plan', or a configured subagent name)"),
          variant: tool.schema
            .string()
            .optional()
            .describe("optional model variant / reasoning effort for the child run (e.g. 'low', 'high', 'max')"),
        },
        async execute(args, ctx) {
          const modelInput = String(args.model ?? "").trim();
          const task = String(args.task ?? "").trim();
          if (!modelInput) return "Error: model is required — e.g. 'google/gemini-2.5-flash' or 'gemini-3.7'. Use discover_models() to list options.";
          if (!task) return "Error: task is required — what should the delegated model do?";

          await registry.load();
          let result = resolver.resolve(modelInput);

          // On NotFound (short OR qualified) / ambiguous short name, try one forced
          // refresh before giving up. Qualified NotFound retry self-heals stale
          // registry caches (models renamed upstream while the cache is old).
          if (result.kind === "not_found" || (result.kind === "ambiguous" && !modelInput.includes("/"))) {
            await registry.load({ force: true });
            // re-create resolver with fresh registry (same object, entries updated)
            const retry = resolver.resolve(modelInput);
            // only upgrade if retry is strictly better (resolved vs ambiguous/not_found)
            if (retry.kind === "resolved") result = retry;
            else if (retry.kind === "ambiguous" && result.kind === "not_found") result = retry;
          }

          if (result.kind === "not_found") return formatNotFound(result);
          if (result.kind === "ambiguous") return formatAmbiguous(result);

          // Resolved → execute via child session
          try {
            const out = await execution.execute(
              result.entry,
              task,
              {
                sessionID: ctx.sessionID,
                abort: ctx.abort,
                directory: ctx.directory,
              },
              {
                ...(typeof args.agent === "string" && args.agent.trim() ? { agent: args.agent.trim() } : {}),
                ...(typeof args.variant === "string" && args.variant.trim() ? { variant: args.variant.trim() } : {}),
              },
            );
            // Structured ToolResult: the TUI Task renderer keys child-session sync,
            // clickable navigation and duration off metadata.sessionId (camelCase).
            return {
              output: renderOutput(out.sessionID, "completed", out.output),
              metadata: {
                sessionId: out.sessionID,
                parentSessionId: ctx.sessionID,
                model: { providerID: result.entry.providerID, modelID: result.entry.modelID },
              },
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            let hint = `Delegate failed: ${msg}`;
            if (msg.includes("ModelUnavailableError") || msg.toLowerCase().includes("model") && msg.toLowerCase().includes("unavailable")) {
              hint = `Model "${result.entry.qualified}" unavailable for this request: ${msg}\nTry another provider for same family, e.g. discover_models("${result.entry.modelID.split("/").pop() ?? result.entry.modelID}")`;
            } else if (msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("api key")) {
              hint = `Provider auth error for "${result.entry.qualified}": ${msg}\nCheck ~/.local/share/opencode/auth.json credential for provider "${result.entry.providerID}".`;
            }
            return {
              output: renderOutput(result.entry.qualified, "error", hint),
              metadata: {
                model: { providerID: result.entry.providerID, modelID: result.entry.modelID },
              },
            };
          }
        },
      }),
    },
  };
};

// OpenCode loads whichever named export matches convention — export both.
export default ModelRouterPlugin;
