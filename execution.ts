/**
 * execution.ts — ExecutionAdapter abstraction.
 *
 * Spawns a child session parented to the invoking session and prompts it with
 * the resolved model. Also PATCHes the tool part's metadata.sessionId while
 * running so the TUI Task renderer shows the child inline (clickable, live).
 */

import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { ModelEntry } from "./registry.js";

export type DelegationResult = {
  output: string;
  model: string; // qualified
  sessionID: string;
  viaPreferred?: boolean;
};

export interface ExecutionAdapter {
  execute(
    entry: ModelEntry,
    task: string,
    ctx: { sessionID: string; abort?: AbortSignal; directory?: string },
    opts?: { agent?: string; variant?: string },
  ): Promise<DelegationResult>;
}

type Deps = {
  client: ReturnType<typeof createOpencodeClient>;
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Structured logging via client.app.log (official recommendation) — best-effort, never fatal. */
async function log(
  client: unknown,
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const c = client as { app?: { log?: (a: unknown) => Promise<unknown> } };
    if (typeof c?.app?.log !== "function") return;
    await c.app.log({ body: { service: "opencode-subagent-delegate", level, message, extra } });
  } catch {}
}

/** Native task-tool shaped envelope — TUI parses state from this. */
export function renderOutput(sessionID: string, state: "completed" | "error", text: string): string {
  return [`<task id="${xmlEscape(sessionID)}" state="${state}">`, "<output>", xmlEscape(text), "</output>", "</task>"].join("\n");
}

/**
 * Live "running" state for the TUI Task renderer. ctx.metadata() is not bridged
 * for plugin tools, so we PATCH the tool part directly: find this call's part by
 * callID in the parent message and write metadata.sessionId via the raw http client.
 * Best-effort — completion metadata is the durable record either way.
 */
async function setRunningMetadata(
  client: unknown,
  ctx: { sessionID?: string; messageID?: string; callID?: string },
  metadata: Record<string, unknown>,
  title?: string,
): Promise<void> {
  try {
    const sessionID = ctx?.sessionID;
    const messageID = ctx?.messageID;
    const callID = ctx?.callID;
    const http = (client as { _client?: { patch?: (a: unknown) => Promise<unknown> } })?._client;
    if (!sessionID || !messageID || !callID || typeof http?.patch !== "function") return;

    const c = client as { session: { message: (a: unknown) => Promise<{ data?: { parts?: Array<Record<string, unknown>> } }> } };
    const msg = await c.session.message({ path: { id: sessionID, messageID } });
    const parts = msg?.data?.parts ?? [];
    const part = parts.find((p) => p.type === "tool" && p.callID === callID) as
      | { id?: string; state?: { status?: string; metadata?: Record<string, unknown> } }
      | undefined;
    if (!part?.id || part.state?.status !== "running") return;

    const next = {
      ...part,
      state: {
        ...part.state,
        ...(title ? { title } : {}),
        metadata: { ...(part.state.metadata ?? {}), ...metadata },
      },
    };
    await http.patch({
      url: `/session/${sessionID}/message/${messageID}/part/${part.id}`,
      body: next,
    });
  } catch {
    // best-effort; never fail delegation over UI metadata
  }
}

export class SessionExecutionAdapter implements ExecutionAdapter {
  constructor(private deps: Deps) {}

  async execute(
    entry: ModelEntry,
    task: string,
    ctx: { sessionID: string; abort?: AbortSignal; directory?: string },
    opts?: { agent?: string; variant?: string },
  ): Promise<DelegationResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientAny = this.deps.client as any;
    const startedAt = Date.now();

    // Child session parented to the invoking session — ALWAYS pass parentID so it
    // nests under the primary chat instead of appearing as a standalone session.
    const title = `delegate:${entry.qualified}`;
    let childID: string;
    const created = await clientAny.session.create({
      body: { parentID: ctx.sessionID, title },
    });
    childID = created?.data?.id;
    if (!childID || typeof childID !== "string") {
      throw new Error(`session.create did not return an id: ${JSON.stringify(created?.error ?? created).slice(0, 300)}`);
    }

    void log(this.deps.client, "info", "delegate started", {
      model: entry.qualified,
      agent: opts?.agent,
      variant: opts?.variant,
      childSessionID: childID,
    });

    // Wire abort → child's own abort endpoint. ctx.abort fires on parent interrupt;
    // the prompt call is blocking, so killing our wait alone would leak a live child.
    let abortHandler: (() => void) | undefined;
    if (ctx.abort) {
      abortHandler = () => {
        try {
          void Promise.resolve(clientAny.session.abort({ path: { id: childID } })).catch(() => {});
        } catch {}
      };
      if (ctx.abort.aborted) abortHandler();
      else ctx.abort.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      // Light up the live TUI branch before the blocking prompt. ctx.callID rides
      // along on the tool context at runtime even though the type omits it.
      await setRunningMetadata(
        this.deps.client,
        ctx as { sessionID?: string; messageID?: string; callID?: string },
        {
          sessionId: childID,
          parentSessionId: ctx.sessionID,
          model: { providerID: entry.providerID, modelID: entry.modelID },
        },
        title,
      );

      // v1 SDK shape: path.id. session.prompt resolves when the child run completes.
      // agent/variant are optional per-call overrides: agent is typed in v1; variant
      // is v2-typed but accepted by the 1.18.x server (verified by test).
      const promptBody: Record<string, unknown> = {
        model: { providerID: entry.providerID, modelID: entry.modelID },
        parts: [{ type: "text", text: task }],
      };
      if (opts?.agent) promptBody.agent = opts.agent;
      if (opts?.variant) promptBody.variant = opts.variant;
      const res = await clientAny.session.prompt({ path: { id: childID }, body: promptBody });

      if (res?.error) {
        const errText = typeof res.error === "string" ? res.error : JSON.stringify(res.error).slice(0, 1000);
        throw new Error(`prompt failed: ${errText}`);
      }

      // Child-run failures surface embedded in the assistant message info, not as
      // top-level res.error (e.g. provider 403s) — detect and fail cleanly.
      const info = res?.data?.info as { error?: { name?: string; data?: { message?: string } } } | undefined;
      if (info?.error) {
        const m = info.error.data?.message ?? info.error.name ?? "unknown child error";
        throw new Error(`child model error: ${m}`);
      }

      // Native task returns only the LAST text part — joining all parts can
      // duplicate/interleave intermediate assistant text.
      const parts: Array<{ type?: string; text?: string }> = res?.data?.parts ?? [];
      const lastText = [...parts].reverse().find((p) => p.type === "text" && typeof p.text === "string")?.text;
      const output = lastText || JSON.stringify(res?.data ?? {}).slice(0, 8000) || "(no output)";

      void log(this.deps.client, "info", "delegate completed", {
        model: entry.qualified,
        childSessionID: childID,
        durationMs: Date.now() - startedAt,
      });
      return { output, model: entry.qualified, sessionID: childID };
    } catch (e) {
      void log(this.deps.client, "error", "delegate failed", {
        model: entry.qualified,
        childSessionID: childID,
        durationMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      if (ctx.abort && abortHandler) ctx.abort.removeEventListener("abort", abortHandler);
    }
  }
}
