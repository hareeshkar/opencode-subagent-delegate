/**
 * Unit tests for config-models.ts — `opencode.json` as an additional free
 * signal alongside the runtime's cost data (dual-source union).
 *
 * Run: npm test
 * Node executes TypeScript directly (type stripping), so no build step.
 */
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeConfigModels, readConfigModels, type ConfigModel } from "../config-models.ts"
import type { ModelEntry } from "../listing.ts"

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  PASS ${name}`)
}

const primary = (providerID: string, modelID: string, opts: Partial<ModelEntry> = {}): ModelEntry => ({
  providerID,
  modelID,
  qualified: `${providerID}/${modelID}`,
  name: opts.name ?? modelID,
  ...opts,
})
const config = (providerID: string, key: string, opts: Partial<ConfigModel> = {}): ConfigModel => ({
  providerID,
  key,
  modelID: opts.modelID ?? key,
  ...opts,
})

console.log("mergeConfigModels — free signal union (primary cost x opencode.json):")
await check("cost missing + config marks free → free", () => {
  const [e] = mergeConfigModels([primary("mimo", "mimo-v2.5-pro")], [config("mimo", "mimo-v2.5-pro", { name: "MiMo V2.5 Pro Free" })])
  assert.equal(e.free, true)
})
await check("all-zero cost + config without signal → free", () => {
  const [e] = mergeConfigModels([primary("zai", "glm-5.3-flash", { free: true })], [config("zai", "glm-5.3-flash", { name: "GLM-5.3-Flash" })])
  assert.equal(e.free, true)
})
await check("all-zero cost + config marks free → free", () => {
  const [e] = mergeConfigModels([primary("p", "m", { free: true })], [config("p", "m", { modelID: "m-free" })])
  assert.equal(e.free, true)
})
await check("paid primary + config marks free → free (union)", () => {
  const [e] = mergeConfigModels([primary("p", "m", { free: false })], [config("p", "m", { name: "M Free" })])
  assert.equal(e.free, true)
})
await check("paid primary + no config signal → not free", () => {
  const [e] = mergeConfigModels([primary("p", "m", { free: false })], [config("p", "m", { name: "M" })])
  assert.equal(e.free, false)
})
await check("missing primary free + no config signal → not free", () => {
  const [e] = mergeConfigModels([primary("p", "m")], [config("p", "m", { name: "M" })])
  assert.equal(e.free ?? false, false)
})

console.log("mergeConfigModels — matching rules:")
await check("never combines across providers", () => {
  const entries = mergeConfigModels([primary("p1", "m")], [config("p2", "m", { name: "M Free" })])
  const p1 = entries.find((e) => e.qualified === "p1/m")
  const p2 = entries.find((e) => e.qualified === "p2/m")
  assert.equal(p1?.free ?? false, false)
  assert.equal(p2?.free, true)
})
await check("matches by config key when the id differs", () => {
  const [e] = mergeConfigModels(
    [primary("p", "real-id", { free: false })],
    [config("p", "real-id", { modelID: "wrapper-id", name: "Free Thing" })],
  )
  assert.equal(e.free, true)
})
await check("appends config-only models", () => {
  const entries = mergeConfigModels([primary("p", "other")], [config("p", "cfg-only", { name: "Cfg Only Free" })])
  assert.equal(entries.length, 2)
  const added = entries.find((e) => e.modelID === "cfg-only")
  assert.equal(added?.free, true)
})
await check("enriches missing family/context, keeps existing values", () => {
  const [e] = mergeConfigModels([primary("p", "m", { context: 111 })], [config("p", "m", { family: "fam", context: 222 })])
  assert.equal(e.context, 111)
  assert.equal(e.family, "fam")
})
await check("does not mutate the input entries", () => {
  const input = primary("p", "m", { free: false })
  mergeConfigModels([input], [config("p", "m", { name: "M Free" })])
  assert.equal(input.free, false)
})
await check("empty config list returns a copy of the entries", () => {
  const input = [primary("p", "m")]
  const out = mergeConfigModels(input, [])
  assert.deepEqual(out, input)
  assert.notEqual(out, input)
})

console.log("readConfigModels:")
await check("reads custom providers from a config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgmodels-"))
  const path = join(dir, "opencode.json")
  writeFileSync(
    path,
    JSON.stringify({
      provider: {
        acme: {
          models: {
            "fast-free": { name: "Fast Free", family: "fast", limit: { context: 100 } },
            plain: { id: "plain-id", name: "Plain" },
          },
        },
      },
    }),
  )
  const models = await readConfigModels(path)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(models.length, 2)
  const fast = models.find((m) => m.key === "fast-free")
  assert.equal(fast?.providerID, "acme")
  assert.equal(fast?.name, "Fast Free")
  assert.equal(fast?.context, 100)
  const plain = models.find((m) => m.key === "plain")
  assert.equal(plain?.modelID, "plain-id")
})
await check("missing file returns an empty list", async () => {
  const models = await readConfigModels("/definitely/not/a/real/opencode.json")
  assert.deepEqual(models, [])
})

console.log(`\nconfig-models.test: ${passed} checks passed`)
