/**
 * opencode-subagent-delegate — dual-entry plugin (OpenCode 1.x + 2.x).
 *
 * A single default export serves both plugin APIs:
 *
 *   OpenCode 2.x               →  setup()   →  V2 promise API (tool editor, session hooks)
 *   OpenCode 1.x (>= 1.18.29)  →  server()  →  V1 hooks (tool map, system transform, events)
 *
 * Implementations:
 *   v2.ts — V2 factory (ctx.tool.transform, ctx.session.*, JSON Schema tools)
 *   v1.ts — V1 factory (tool() helper, experimental.chat.system.transform, v1 SDK client)
 *
 * The two implementations share behavior, not code: V1 drives the v1 SDK client
 * surface, V2 uses the 2.x plugin context. Keep them in sync when adding features.
 *
 * `engines.opencode >= 1.18.29` (package.json) — object entrypoints with server()
 * landed in OpenCode 1.18.29. Older 1.x users should pin <= 1.2.5.
 */

import { ModelRouterPlugin } from "./v1.js"
import v2 from "./v2.js"

export default {
  id: "opencode-subagent-delegate",
  setup: v2.setup,
  server: ModelRouterPlugin,
}
