/**
 * Unit tests for the shared listing helpers (pure logic — no plugin runtime).
 *
 * Run: npm test
 * Node 22+ executes TypeScript directly (type stripping), so no build step.
 */
import assert from "node:assert/strict"
import { isFreeModel, renderFreeResults, renderSearchResults, type ModelEntry } from "../listing.ts"

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  PASS ${name}`)
}

console.log("isFreeModel:")
check("zero-cost tiers → free even without a free-looking name", () => {
  assert.equal(isFreeModel("glm-5.3-flash", "GLM-5.3-Flash", [{ input: 0, output: 0 }]), true)
})
check("cost missing + -free id → free (fallback)", () => {
  assert.equal(isFreeModel("mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free", undefined), true)
})
check("cost missing + 'Free' name → free (fallback)", () => {
  assert.equal(isFreeModel("space-bunny", "Space Bunny Free", undefined), true)
})
check("cost missing, no free signal → not free", () => {
  assert.equal(isFreeModel("bailian-model", "Bailian Model", undefined), false)
})
check("paid tiers → not free", () => {
  assert.equal(isFreeModel("gpt-5.4", "GPT-5.4", [{ input: 2.5, output: 10, cache: { read: 0, write: 0 } }]), false)
})
check("mixed tiers (any non-zero) → not free", () => {
  assert.equal(isFreeModel("m", "M", [{ input: 0, output: 0 }, { input: 1, output: 1 }]), false)
})
check("empty cost array falls back to naming", () => {
  assert.equal(isFreeModel("hy3-free", "HY3 Free", []), true)
  assert.equal(isFreeModel("hy3", "HY3", []), false)
})

const entry = (providerID: string, modelID: string, free = false): ModelEntry => ({
  providerID,
  modelID,
  qualified: `${providerID}/${modelID}`,
  name: modelID,
  context: 1000,
  free,
})

console.log("renderSearchResults:")
check("annotates sibling providers and marks free siblings", () => {
  const all = [
    entry("opencode-go", "glm-5.3-flash"),
    entry("llmgateway", "glm-5.3-flash"),
    entry("opencode", "glm-5.3-flash"),
    entry("zai-coding-plan", "glm-5.3-flash", true),
  ]
  const out = renderSearchResults([all[0]], all, 1, "glm-5.3-flash")
  assert.match(out, /opencode-go\/glm-5.3-flash/)
  assert.match(out, /also: llmgateway, opencode, zai-coding-plan \(free\)/)
  assert.match(out, /Found 1 of 1/)
})
check("marks the shown entry as free", () => {
  const all = [entry("zai-coding-plan", "glm-5.3-flash", true)]
  const out = renderSearchResults([all[0]], all, 1, "glm")
  assert.match(out, /· free/)
})
check("caps sibling list at 4 with +N", () => {
  const all = [
    entry("p1", "m"),
    entry("p2", "m"),
    entry("p3", "m"),
    entry("p4", "m"),
    entry("p5", "m"),
    entry("p6", "m"),
  ]
  const out = renderSearchResults([all[0]], all, 1, "m")
  assert.match(out, /also: p2, p3, p4, p5 \+1/)
})

console.log("renderFreeResults:")
check("groups by provider, counts, caps ids per provider", () => {
  const models = [
    ...Array.from({ length: 8 }, (_, i) => entry("nvidia", `m${i}`, true)),
    entry("opencode", "mimo-v2.6-flash-free", true),
    entry("opencode", "glm-5-free", true),
  ]
  const out = renderFreeResults(models, models.length, "")
  assert.match(out, /Free models — 10 across 2 providers:/)
  assert.match(out, /- nvidia \(8\): m0, m1, m2, m3, m4, m5, …/)
  assert.match(out, /- opencode \(2\): mimo-v2\.6-flash-free, glm-5-free/)
  assert.match(out, /rate-limited/)
})
check("query header when filtered", () => {
  const models = [entry("opencode", "kimi-k2.5-free", true)]
  const out = renderFreeResults(models, 1, "kimi")
  assert.match(out, /Free models matching "kimi" — 1 across 1 providers:/)
})

console.log(`\nlisting.test: ${passed} checks passed`)
