/**
 * Tests for the Claude Code settings writer.
 *
 * The overriding concern is that switching must never damage a user's
 * settings.json: unrelated keys survive, malformed files are refused rather
 * than overwritten, and writes are atomic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyProfile,
  readSettings,
  writeSettings,
  switchTo,
  currentTarget,
} from "../src/config/claude.js";

const profile = {
  name: "my-claude",
  displayName: "my-claude",
  baseUrl: "http://localhost:8000",
  clientModelId: "my-claude",
  requiresAuth: false,
};

async function scratchFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "kong-ai-switch-"));
  return path.join(dir, "settings.json");
}

test("applyProfile sets the three env keys Claude Code reads", () => {
  const next = applyProfile({}, profile);
  assert.equal(next.env.ANTHROPIC_BASE_URL, "http://localhost:8000");
  assert.equal(next.env.ANTHROPIC_MODEL, "my-claude");
  assert.equal(next.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, "1");
});

test("applyProfile preserves unrelated settings and env vars", () => {
  const existing = {
    theme: "dark",
    permissions: { allow: ["Bash(ls:*)"] },
    env: { MY_OWN_VAR: "keep me", ANTHROPIC_BASE_URL: "https://old.example" },
  };
  const next = applyProfile(existing, profile);

  assert.equal(next.theme, "dark");
  assert.deepEqual(next.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(next.env.MY_OWN_VAR, "keep me");
  assert.equal(next.env.ANTHROPIC_BASE_URL, "http://localhost:8000");
});

test("applyProfile does not mutate its input", () => {
  const existing = { env: { ANTHROPIC_MODEL: "before" } };
  applyProfile(existing, profile);
  assert.equal(existing.env.ANTHROPIC_MODEL, "before");
});

test("an explicit token is written through", () => {
  const next = applyProfile({}, { ...profile, requiresAuth: true }, { token: "secret-key" });
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, "secret-key");
});

test("an unauthenticated gateway still gets a placeholder token", () => {
  // Without a token Claude Code may fall back to its own credentials and
  // silently bypass the gateway, which defeats the point of routing through it.
  const next = applyProfile({}, profile);
  assert.ok(next.env.ANTHROPIC_AUTH_TOKEN);
});

test("an existing user token is not clobbered by the placeholder", () => {
  const next = applyProfile({ env: { ANTHROPIC_AUTH_TOKEN: "mine" } }, profile);
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, "mine");
});

test("a missing settings file is reported, not thrown", async () => {
  const file = await scratchFile();
  const { settings, existed } = await readSettings(file);
  assert.deepEqual(settings, {});
  assert.equal(existed, false);
});

test("malformed JSON is refused rather than overwritten", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ this is not json", "utf8");
  await assert.rejects(() => readSettings(file), /not valid JSON/);

  // The damaged file must still be on disk, untouched.
  assert.equal(await readFile(file, "utf8"), "{ this is not json");
});

test("a JSON array is rejected as a settings object", async () => {
  const file = await scratchFile();
  await writeFile(file, "[1,2,3]", "utf8");
  await assert.rejects(() => readSettings(file), /not valid JSON/);
});

test("an empty file is treated as empty settings", async () => {
  const file = await scratchFile();
  await writeFile(file, "   \n", "utf8");
  const { settings, existed } = await readSettings(file);
  assert.deepEqual(settings, {});
  assert.equal(existed, true);
});

test("switchTo writes the file and reports what changed", async () => {
  const file = await scratchFile();
  const result = await switchTo(profile, { file });

  assert.equal(result.created, true);
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.env.ANTHROPIC_BASE_URL, "http://localhost:8000");

  const keys = result.changes.map((c) => c.key);
  assert.ok(keys.includes("ANTHROPIC_BASE_URL"));
  assert.ok(keys.includes("ANTHROPIC_MODEL"));
});

test("switching twice reports only the keys that actually moved", async () => {
  const file = await scratchFile();
  await switchTo(profile, { file });
  const second = await switchTo(
    { ...profile, name: "other", clientModelId: "other" },
    { file },
  );

  const keys = second.changes.map((c) => c.key);
  assert.deepEqual(keys, ["ANTHROPIC_MODEL"]);
  assert.equal(second.changes[0].from, "my-claude");
  assert.equal(second.changes[0].to, "other");
});

test("no temp files are left behind after a write", async () => {
  const file = await scratchFile();
  await switchTo(profile, { file });
  const entries = await readdir(path.dirname(file));
  assert.deepEqual(entries, ["settings.json"]);
});

test("written settings round-trip as valid JSON", async () => {
  const file = await scratchFile();
  await writeSettings({ env: { A: "1" }, nested: { deep: [1, 2] } }, file);
  const parsed = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(parsed.nested.deep, [1, 2]);
});

test("currentTarget reads back what was written", async () => {
  const file = await scratchFile();
  await switchTo(profile, { file });
  const active = await currentTarget(file);
  assert.equal(active.baseUrl, "http://localhost:8000");
  assert.equal(active.model, "my-claude");
  assert.equal(active.hasToken, true);
});

test("currentTarget is null when nothing is configured", async () => {
  const file = await scratchFile();
  assert.equal(await currentTarget(file), null);

  await writeSettings({ theme: "dark" }, file);
  assert.equal(await currentTarget(file), null);
});
