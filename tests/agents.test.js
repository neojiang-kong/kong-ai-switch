/**
 * Tests for multi-agent config writing.
 *
 * The property that matters most: pointing one agent at a gateway must not
 * damage another agent's config, and must not damage the user's own settings
 * inside the file it does touch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listAgents,
  getAgent,
  agentSupportsFormat,
  agentsForModel,
  applyToAgent,
  agentStatus,
} from "../src/config/agents.js";

const anthropicProfile = {
  name: "my-claude",
  displayName: "Claude Opus",
  format: "anthropic",
  baseUrl: "http://localhost:8000",
  clientModelId: "my-claude",
  requiresAuth: false,
};

const openaiProfile = {
  name: "my-gpt",
  displayName: "GPT-5",
  format: "openai",
  baseUrl: "http://localhost:8000/openai",
  clientModelId: "my-gpt",
  requiresAuth: false,
};

async function scratchHome() {
  return mkdtemp(path.join(tmpdir(), "kong-agents-"));
}

test("the known agents are listed with their formats", () => {
  const ids = listAgents().map((a) => a.id);
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("codex"));
  assert.deepEqual(getAgent("claude-code").formats, ["anthropic"]);
  assert.deepEqual(getAgent("codex").formats, ["openai"]);
});

test("an unknown agent names the ones that exist", () => {
  assert.throws(() => getAgent("emacs"), /Known agents/);
});

test("format support is enforced per agent", () => {
  assert.equal(agentSupportsFormat("claude-code", "anthropic"), true);
  assert.equal(agentSupportsFormat("claude-code", "openai"), false);
  assert.equal(agentSupportsFormat("codex", "openai"), true);
});

test("agentsForModel explains why an agent cannot be used", () => {
  const { supported, unsupported } = agentsForModel("anthropic");
  assert.ok(supported.some((a) => a.id === "claude-code"));
  const codex = unsupported.find((a) => a.id === "codex");
  assert.match(codex.reason, /Codex CLI speaks openai/);
});

test("Claude Code gets the env keys it reads", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("claude-code", anthropicProfile, { home });

  const written = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(written.env.ANTHROPIC_BASE_URL, "http://localhost:8000");
  assert.equal(written.env.ANTHROPIC_MODEL, "my-claude");
  assert.equal(written.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, "1");
  assert.equal(result.created, true);
});

test("Claude Code keeps the user's unrelated settings", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ theme: "dark", env: { MY_VAR: "keep" } }),
    "utf8",
  );

  const result = await applyToAgent("claude-code", anthropicProfile, { home });
  const written = JSON.parse(await readFile(result.file, "utf8"));

  assert.equal(written.theme, "dark");
  assert.equal(written.env.MY_VAR, "keep");
  assert.equal(written.env.ANTHROPIC_MODEL, "my-claude");
});

test("an agent refuses a model format it cannot call", async () => {
  const home = await scratchHome();
  await assert.rejects(
    () => applyToAgent("claude-code", openaiProfile, { home }),
    /cannot call "my-gpt"/,
  );
  await assert.rejects(
    () => applyToAgent("codex", anthropicProfile, { home }),
    /cannot call "my-claude"/,
  );
});

test("Codex gets a managed TOML block", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("codex", openaiProfile, { home });
  const text = await readFile(result.file, "utf8");

  assert.match(text, /model_provider = "kong"/);
  assert.match(text, /model = "my-gpt"/);
  assert.match(text, /base_url = "http:\/\/localhost:8000\/openai"/);
  assert.match(text, /\[model_providers\.kong\]/);
});

test("Codex keeps the user's own TOML outside the managed block", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
    "utf8",
  );

  const result = await applyToAgent("codex", openaiProfile, { home });
  const text = await readFile(result.file, "utf8");

  assert.match(text, /approval_policy = "on-request"/);
  assert.match(text, /sandbox_mode = "workspace-write"/);
  assert.match(text, /model_provider = "kong"/);
});

test("switching Codex twice replaces the block rather than appending", async () => {
  const home = await scratchHome();
  await applyToAgent("codex", openaiProfile, { home });
  const result = await applyToAgent(
    "codex",
    { ...openaiProfile, clientModelId: "other-gpt" },
    { home },
  );
  const text = await readFile(result.file, "utf8");

  assert.equal(text.match(/\[model_providers\.kong\]/g).length, 1);
  assert.match(text, /model = "other-gpt"/);
  assert.doesNotMatch(text, /model = "my-gpt"/);
});

test("writing one agent does not touch another's config", async () => {
  const home = await scratchHome();
  await applyToAgent("claude-code", anthropicProfile, { home });
  await applyToAgent("codex", openaiProfile, { home });

  const claude = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
  const codex = await readFile(path.join(home, ".codex", "config.toml"), "utf8");

  assert.equal(claude.env.ANTHROPIC_MODEL, "my-claude");
  assert.match(codex, /model = "my-gpt"/);
  // Each agent's file mentions only its own model.
  assert.doesNotMatch(JSON.stringify(claude), /my-gpt/);
  assert.doesNotMatch(codex, /my-claude/);
});

test("a token is written through for each agent", async () => {
  const home = await scratchHome();
  await applyToAgent("claude-code", anthropicProfile, { home, token: "consumer-key" });
  const claude = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "consumer-key");

  const codexResult = await applyToAgent("codex", openaiProfile, { home, token: "consumer-key" });
  const codex = await readFile(codexResult.file, "utf8");
  // The token itself is referenced by env var, never written to the file.
  assert.match(codex, /env_key = "KONG_AI_TOKEN"/);
  assert.doesNotMatch(codex, /consumer-key/);
});

test("a key-auth credential travels in its own header, not as a bearer token", async () => {
  // Claude Code sends ANTHROPIC_AUTH_TOKEN as a bearer Authorization header,
  // which a key-auth strategy ignores. The key must go via a custom header or
  // the gateway answers 401.
  const home = await scratchHome();
  const keyAuthProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
    },
  };

  const result = await applyToAgent("claude-code", keyAuthProfile, { home, token: "my-key" });
  const written = JSON.parse(await readFile(result.file, "utf8"));

  assert.equal(written.env.ANTHROPIC_CUSTOM_HEADERS, "apikey: my-key");
  // The key must not leak into the bearer token.
  assert.notEqual(written.env.ANTHROPIC_AUTH_TOKEN, "my-key");
  // But a non-empty token is still needed, or Claude Code uses its own creds.
  assert.ok(written.env.ANTHROPIC_AUTH_TOKEN);
});

test("a custom key name is honoured in the header", async () => {
  const home = await scratchHome();
  const profile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: { required: true, preferred: { kind: "key-auth", header: "X-API-Key" } },
  };
  const result = await applyToAgent("claude-code", profile, { home, token: "k" });
  const written = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(written.env.ANTHROPIC_CUSTOM_HEADERS, "X-API-Key: k");
});

test("an OIDC bearer token goes in ANTHROPIC_AUTH_TOKEN", async () => {
  const home = await scratchHome();
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "openid-connect", header: "Authorization" },
    },
  };

  const result = await applyToAgent("claude-code", oidcProfile, { home, token: "bearer-xyz" });
  const written = JSON.parse(await readFile(result.file, "utf8"));

  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "bearer-xyz");
  assert.equal(written.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("a dual-strategy model honours an explicit OIDC choice", async () => {
  const home = await scratchHome();
  const dualProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      hasChoice: true,
      preferred: { kind: "key-auth", header: "apikey" },
      strategies: [
        { kind: "key-auth", header: "apikey" },
        { kind: "openid-connect", header: "Authorization" },
      ],
    },
  };

  const result = await applyToAgent("claude-code", dualProfile, {
    home,
    token: "bearer-xyz",
    authKind: "openid-connect",
  });
  const written = JSON.parse(await readFile(result.file, "utf8"));

  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "bearer-xyz");
  assert.equal(written.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("agentStatus reads back what was written", async () => {
  const home = await scratchHome();
  await applyToAgent("claude-code", anthropicProfile, { home });

  const status = await agentStatus("claude-code", { home });
  assert.equal(status.configured, true);
  assert.equal(status.model, "my-claude");
  assert.equal(status.baseUrl, "http://localhost:8000");
});

test("agentStatus reports an unconfigured agent", async () => {
  const home = await scratchHome();
  const status = await agentStatus("codex", { home });
  assert.equal(status.configured, false);
});

test("Claude Desktop shares Claude Code's settings file", () => {
  const desktop = getAgent("claude-desktop");
  assert.equal(desktop.sharesConfigWith, "claude-code");
  assert.equal(
    desktop.configPath("/home/x"),
    getAgent("claude-code").configPath("/home/x"),
  );
});

test("malformed JSON is refused rather than overwritten", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const file = path.join(home, ".claude", "settings.json");
  await writeFile(file, "{ broken", "utf8");

  await assert.rejects(() => applyToAgent("claude-code", anthropicProfile, { home }), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{ broken");
});
