/**
 * Tests for multi-agent config writing.
 *
 * The property that matters most: pointing one agent at a gateway must not
 * damage another agent's config, and must not damage the user's own settings
 * inside the file it does touch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  listAgents,
  getAgent,
  agentSupportsFormat,
  agentsForModel,
  applyToAgent,
  agentStatus,
  applyCursorLocalEnv,
  setCursorUserEnv,
  buildClaudeDesktopProfile,
  detectInstall,
  describeAgent,
  formatAgentsTable,
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
  assert.ok(ids.includes("github-copilot"));
  assert.ok(ids.includes("cursor"));
  assert.ok(ids.includes("hermes"));
  assert.ok(ids.includes("openclaw"));
  assert.deepEqual(getAgent("claude-code").formats, ["anthropic"]);
  assert.deepEqual(getAgent("codex").formats, ["openai"]);
  assert.deepEqual(getAgent("github-copilot").formats, ["openai", "anthropic"]);
  assert.deepEqual(getAgent("cursor").formats, ["openai", "anthropic"]);
  assert.equal(getAgent("claude-code").switchable, true);
  assert.equal(getAgent("hermes").switchable, false);
  assert.equal(getAgent("openclaw").switchable, false);
  assert.equal(getAgent("hermes").vendor, "nous");
  assert.equal(getAgent("openclaw").vendor, "openclaw");
  assert.deepEqual(getAgent("hermes").formats, ["openai"]);
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
  // Codex must not require a shell export — the key is in the provider block.
  assert.match(codex, /experimental_bearer_token = "consumer-key"/);
  assert.doesNotMatch(codex, /env_key = "KONG_AI_TOKEN"/);
});

test("Codex key-auth credentials travel in http_headers, not as a bearer token", async () => {
  // Kong key-auth ignores Authorization; Codex env_key would send Bearer and 401.
  const home = await scratchHome();
  const keyAuthProfile = {
    ...openaiProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
    },
  };

  const result = await applyToAgent("codex", keyAuthProfile, { home, token: "my-key" });
  const text = await readFile(result.file, "utf8");

  // Inline map — a nested [http_headers] table would swallow following bare keys.
  assert.match(text, /http_headers = \{ apikey = "my-key" \}/);
  assert.doesNotMatch(text, /\[model_providers\.kong\.http_headers\]/);
  assert.match(text, /requires_openai_auth = false/);
  // A placeholder Bearer makes dual-auth gateways (OIDC + key-auth) 401.
  assert.doesNotMatch(text, /experimental_bearer_token/);
  assert.doesNotMatch(text, /env_key/);
});

test("Codex managed root keys sit at top; provider table at end (no open nested table)", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    [
      'model_reasoning_effort = "low"',
      "disable_response_storage = true",
      "",
      '[projects."/Users/example/demo"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
    "utf8",
  );

  const keyAuthProfile = {
    ...openaiProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
    },
  };
  const result = await applyToAgent("codex", keyAuthProfile, { home, token: "k" });
  const text = await readFile(result.file, "utf8");

  const rootBegin = text.indexOf("# >>> kong-ai-switch (managed) >>>");
  const projectsAt = text.indexOf('[projects."/Users/example/demo"]');
  const providerAt = text.indexOf("[model_providers.kong]");
  const providerBegin = text.indexOf("# >>> kong-ai-switch (managed-provider) >>>");

  assert.ok(rootBegin === 0 || text.trimStart().startsWith("# >>> kong-ai-switch"));
  assert.ok(rootBegin < projectsAt, "managed root must precede [projects] tables");
  assert.ok(providerAt > projectsAt, "provider table must follow user content");
  assert.ok(providerBegin > projectsAt, "managed-provider block must be at end");
  assert.match(text, /supports_websockets = false/);
  assert.match(text, /http_headers = \{ apikey = "k" \}/);
  assert.doesNotMatch(text, /\[model_providers\.kong\.http_headers\]/);
  // OpenAI-only; Kong/upstream rejects reasoning.effort for gateway model ids.
  assert.doesNotMatch(text, /model_reasoning_effort/);

  // User root keys must remain root — not absorbed under http_headers.
  const disableIdx = text.indexOf("disable_response_storage = true");
  const httpHeadersIdx = text.indexOf("http_headers =");
  assert.ok(disableIdx !== -1);
  assert.ok(disableIdx < providerAt, "disable_response_storage must stay with user content");
  assert.ok(httpHeadersIdx > providerAt);
});

test("Codex scrub removes a competing custom provider aimed at the same gateway", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    [
      'model_provider = "custom"',
      'model = "openai"',
      "",
      "[model_providers.custom]",
      'name = "custom"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      `base_url = "${openaiProfile.baseUrl}/"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const keyAuthProfile = {
    ...openaiProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
    },
  };
  const result = await applyToAgent("codex", keyAuthProfile, {
    home,
    token: "my-key",
  });
  const text = await readFile(result.file, "utf8");

  assert.equal((text.match(/model_provider = /g) || []).length, 1);
  assert.match(text, /model_provider = "kong"/);
  assert.match(text, /disabled-by-kong-ai-switch/);
  assert.doesNotMatch(text, /requires_openai_auth = true/);
});

test("Codex agentStatus reads model/baseUrl from the managed block only", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    [
      "# >>> kong-ai-switch (managed) >>>",
      'model_provider = "kong"',
      'model = "my-gpt"',
      "# <<< kong-ai-switch (managed) <<<",
      "",
      "[model_providers.custom]",
      'base_url = "http://127.0.0.1:9/disabled-by-kong-ai-switch"',
      "",
      "# >>> kong-ai-switch (managed-provider) >>>",
      "[model_providers.kong]",
      'base_url = "http://localhost:8000/openai"',
      'wire_api = "responses"',
      'http_headers = { apikey = "k" }',
      "# <<< kong-ai-switch (managed-provider) <<<",
      "",
    ].join("\n"),
    "utf8",
  );

  const status = await agentStatus("codex", { home });
  assert.equal(status.configured, true);
  assert.equal(status.model, "my-gpt");
  assert.equal(status.baseUrl, "http://localhost:8000/openai");
  assert.equal(status.hasToken, true);
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

test("switching back to key-auth clears a previous OIDC bearer", async () => {
  // Dual-strategy models reject a stale Bearer even when apikey is valid.
  // Leaving the OIDC token in ANTHROPIC_AUTH_TOKEN after an API-key switch
  // is what made "API key stopped working" after trying OIDC once.
  const home = await scratchHome();
  const dual = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
      strategies: [
        { kind: "key-auth", header: "apikey" },
        { kind: "openid-connect", header: "Authorization" },
      ],
    },
  };

  await applyToAgent("claude-code", dual, {
    home,
    token: "stale-bearer",
    authKind: "openid-connect",
  });
  const afterOidc = JSON.parse(
    await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.equal(afterOidc.env.ANTHROPIC_AUTH_TOKEN, "stale-bearer");
  assert.equal(afterOidc.env.ANTHROPIC_CUSTOM_HEADERS, undefined);

  await applyToAgent("claude-code", dual, {
    home,
    token: "my-api-key",
    authKind: "key-auth",
  });
  const afterKey = JSON.parse(
    await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
  );

  assert.equal(afterKey.env.ANTHROPIC_CUSTOM_HEADERS, "apikey: my-api-key");
  assert.equal(afterKey.env.ANTHROPIC_AUTH_TOKEN, "kong-ai-gateway");
  assert.notEqual(afterKey.env.ANTHROPIC_AUTH_TOKEN, "stale-bearer");
});

test("switching to OIDC clears a previous apikey custom header", async () => {
  const home = await scratchHome();
  const dual = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
      strategies: [
        { kind: "key-auth", header: "apikey" },
        { kind: "openid-connect", header: "Authorization" },
      ],
    },
  };

  await applyToAgent("claude-code", dual, { home, token: "old-key", authKind: "key-auth" });
  await applyToAgent("claude-code", dual, {
    home,
    token: "fresh-bearer",
    authKind: "openid-connect",
  });
  const written = JSON.parse(
    await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
  );

  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "fresh-bearer");
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

test("GitHub Copilot gets settings.json and a sourced env file", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("github-copilot", openaiProfile, {
    home,
    token: "copilot-key",
  });

  const settings = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(settings.model, "my-gpt");

  const envText = await readFile(result.envFile, "utf8");
  assert.match(envText, /COPILOT_PROVIDER_BASE_URL='http:\/\/localhost:8000\/openai'/);
  assert.match(envText, /COPILOT_PROVIDER_TYPE='openai'/);
  assert.match(envText, /COPILOT_MODEL='my-gpt'/);
  assert.match(envText, /COPILOT_PROVIDER_API_KEY='copilot-key'/);
});

test("GitHub Copilot maps anthropic-format models to provider type anthropic", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("github-copilot", anthropicProfile, { home, token: "k" });
  const envText = await readFile(result.envFile, "utf8");
  assert.match(envText, /COPILOT_PROVIDER_TYPE='anthropic'/);
});

test("GitHub Copilot agentStatus reads model and base URL", async () => {
  const home = await scratchHome();
  await applyToAgent("github-copilot", openaiProfile, { home, token: "k" });
  const status = await agentStatus("github-copilot", { home });
  assert.equal(status.configured, true);
  assert.equal(status.model, "my-gpt");
  assert.equal(status.baseUrl, "http://localhost:8000/openai");
});

test("Cursor uses Magpie's Private Inference variables and leaves ~/.cursor alone", async () => {
  const home = await scratchHome();
  const calls = [];
  const result = await applyToAgent("cursor", openaiProfile, {
    home,
    token: "cursor-key",
    userEnv: async (env) => {
      calls.push(env);
      return true;
    },
  });

  const text = await readFile(result.file, "utf8");
  assert.match(text, /export CURSOR_LOCAL_AGENT_BASE_URL='http:\/\/localhost:8000\/openai'/);
  assert.match(text, /export CURSOR_LOCAL_AGENT_API_KEY='cursor-key'/);
  assert.match(text, /# model=my-gpt/);
  assert.equal(result.file, path.join(home, ".kong-ai-switch", "cursor-local.env"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].CURSOR_LOCAL_AGENT_BASE_URL, "http://localhost:8000/openai");
  assert.equal(calls[0].CURSOR_LOCAL_AGENT_API_KEY, "cursor-key");
  await assert.rejects(() => readFile(path.join(home, ".cursor", "cli-config.json"), "utf8"));

  const status = await agentStatus("cursor", { home });
  assert.equal(status.configured, true);
  assert.equal(status.model, "my-gpt");
  assert.equal(status.baseUrl, "http://localhost:8000/openai");
  assert.equal(status.hasToken, true);
});

test("Cursor accepts an anthropic-format model on the same variables", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("cursor", anthropicProfile, { home, token: "k", userEnv: false });
  const text = await readFile(result.file, "utf8");
  assert.match(text, /CURSOR_LOCAL_AGENT_BASE_URL='http:\/\/localhost:8000'/);
  assert.match(text, /# model=my-claude/);
  assert.equal(result.userEnv, false);
});

test("Cursor launchctl sets both variables and does not echo the key in errors", async () => {
  const calls = [];
  const applied = await setCursorUserEnv(
    { CURSOR_LOCAL_AGENT_BASE_URL: "http://gw", CURSOR_LOCAL_AGENT_API_KEY: "secret" },
    {
      platform: "darwin",
      run: async (_cmd, args) => {
        calls.push(args);
      },
    },
  );
  assert.equal(applied, true);
  assert.deepEqual(calls, [
    ["setenv", "CURSOR_LOCAL_AGENT_BASE_URL", "http://gw"],
    ["setenv", "CURSOR_LOCAL_AGENT_API_KEY", "secret"],
  ]);

  const skipped = await setCursorUserEnv({}, { platform: "linux", run: async () => calls.push("nope") });
  assert.equal(skipped, false);
  assert.equal(calls.length, 2);

  await assert.rejects(
    () =>
      setCursorUserEnv(
        { CURSOR_LOCAL_AGENT_BASE_URL: "http://gw", CURSOR_LOCAL_AGENT_API_KEY: "secret" },
        {
          platform: "darwin",
          run: async () => {
            const error = new Error("launchctl setenv CURSOR_LOCAL_AGENT_API_KEY secret failed");
            error.code = 1;
            throw error;
          },
        },
      ),
    (error) => {
      assert.match(error.message, /launchctl/);
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("Cursor env file quotes a key that contains a quote", () => {
  const text = applyCursorLocalEnv(openaiProfile, { token: "a'b" });
  assert.match(text, /CURSOR_LOCAL_AGENT_API_KEY='a'\\''b'/);
});

test("agents declare a vendor for the UI", () => {
  assert.equal(getAgent("claude-code").vendor, "anthropic");
  assert.equal(getAgent("codex").vendor, "openai");
  assert.equal(getAgent("github-copilot").vendor, "github");
  assert.equal(getAgent("claude-desktop").vendor, "anthropic");
  assert.equal(getAgent("claude-desktop").kind, "claude-desktop-3p");
  assert.equal(getAgent("claude-desktop").sharesConfigWith, undefined);
});

test("Claude Desktop profile id is a real UUID", () => {
  const id = getAgent("claude-desktop").profileId;
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});

test("Claude Desktop writes configLibrary, not ~/.claude/settings.json", async () => {
  const home = await scratchHome();
  const keyAuthProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: { kind: "key-auth", header: "apikey" },
    },
  };

  const result = await applyToAgent("claude-desktop", keyAuthProfile, {
    home,
    token: "my-apikey",
  });

  assert.match(result.file, /Claude-3p[/\\]configLibrary[/\\]/);
  assert.doesNotMatch(result.file, /\.claude[/\\]settings\.json$/);

  const body = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(body.inferenceProvider, "gateway");
  assert.equal(body.inferenceGatewayBaseUrl, "http://localhost:8000");
  assert.equal(body.inferenceCredentialKind, "static");
  assert.equal(body.inferenceModels[0].name, "my-claude");
  assert.equal(body.modelDiscoveryEnabled, false);
  assert.equal(body.inferenceCustomHeaders.apikey, "my-apikey");

  const meta = JSON.parse(
    await readFile(path.join(path.dirname(result.file), "_meta.json"), "utf8"),
  );
  assert.equal(meta.appliedId, getAgent("claude-desktop").profileId);
  assert.ok(meta.entries.some((e) => e.id === meta.appliedId));

  // Claude Code file must stay untouched.
  await assert.rejects(
    () => readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    /ENOENT/,
  );

  const status = await agentStatus("claude-desktop", { home });
  assert.equal(status.configured, true);
  assert.equal(status.model, "my-claude");
  assert.equal(status.baseUrl, "http://localhost:8000");
});

test("Claude Desktop OIDC with a token writes static JWT like Desktop export", async () => {
  const home = await scratchHome();
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        header: "Authorization",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };

  const result = await applyToAgent("claude-desktop", oidcProfile, {
    home,
    token: "eyJ-access",
  });
  const body = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(body.inferenceCredentialKind, "static");
  assert.equal(body.inferenceGatewayApiKey, "eyJ-access");
  assert.equal(body.inferenceGatewayOidc, undefined);
  assert.equal(body.inferenceGatewayOidcAuthFlow, undefined);
  assert.equal(body.inferenceGatewayAuthScheme, undefined);
  assert.equal(body.modelDiscoveryEnabled, false);
  // No trailing slash — matches Desktop-exported working profiles.
  assert.equal(body.inferenceGatewayBaseUrl, "http://localhost:8000");
});

test("Claude Desktop OIDC without a token keeps interactive PKCE only", async () => {
  const home = await scratchHome();
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        header: "Authorization",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };

  const result = await applyToAgent("claude-desktop", oidcProfile, { home });
  const body = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(body.inferenceCredentialKind, "interactive");
  assert.equal(body.inferenceGatewayOidcAuthFlow, "browser");
  assert.equal(body.inferenceGatewayOidc.issuer, "https://idp.example.com/realms/demo");
  assert.equal(body.inferenceGatewayOidc.clientId, "claude-desktop");
  assert.equal(body.inferenceGatewayApiKey, undefined);
});

test("Claude Desktop Entra OIDC with token is static (no interactive mix)", async () => {
  const home = await scratchHome();
  const payload = Buffer.from(
    JSON.stringify({ azp: "20167183-7ef7-48f2-9763-1d30199e32a9" }),
  ).toString("base64url");
  const token = `hdr.${payload}.sig`;
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        header: "Authorization",
        issuer: "https://login.microsoftonline.com/f177c1d6-50cf-49e0-818a-a0585cbafd8d/v2.0",
      },
    },
  };

  const result = await applyToAgent("claude-desktop", oidcProfile, { home, token });
  const body = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(body.inferenceCredentialKind, "static");
  assert.equal(body.inferenceGatewayApiKey, token);
  assert.equal(body.inferenceGatewayOidc, undefined);
});

test("Claude Desktop Entra OIDC without token needs client id for interactive", async () => {
  const home = await scratchHome();
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
      },
    },
  };
  await assert.rejects(
    () => applyToAgent("claude-desktop", oidcProfile, { home }),
    /KONG_AI_OIDC_CLIENT_ID/,
  );
});

test("Claude Desktop interactive mode ignores token (never mixes with apiKey)", async () => {
  const home = await scratchHome();
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        header: "Authorization",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };

  const result = await applyToAgent("claude-desktop", oidcProfile, {
    home,
    token: "should-be-ignored",
    credentialMode: "interactive",
  });
  const body = JSON.parse(await readFile(result.file, "utf8"));
  assert.equal(body.inferenceCredentialKind, "interactive");
  assert.equal(body.inferenceGatewayApiKey, undefined);
  assert.equal(body.inferenceGatewayOidc.issuer, "https://idp.example.com/realms/demo");
  assert.equal(body.inferenceGatewayOidcAuthFlow, "browser");
});

test("Claude Desktop static mode with token is the default export shape", () => {
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };
  const body = buildClaudeDesktopProfile(oidcProfile, {
    token: "eyJ-static",
    credentialMode: "static",
  });
  assert.equal(body.inferenceCredentialKind, "static");
  assert.equal(body.inferenceGatewayApiKey, "eyJ-static");
  assert.equal(body.modelDiscoveryEnabled, false);
  assert.equal(body.inferenceGatewayBaseUrl, "http://localhost:8000");
  assert.equal(body.inferenceModels[0].labelOverride, "Claude Opus");
  assert.equal(body.inferenceGatewayOidc, undefined);
});

test("Claude Desktop trailing slash, discovery, and label override flags", () => {
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };
  const withSlash = buildClaudeDesktopProfile(oidcProfile, {
    token: "t",
    trailingSlash: true,
    modelDiscoveryEnabled: true,
    includeLabelOverride: false,
  });
  assert.equal(withSlash.inferenceGatewayBaseUrl, "http://localhost:8000/");
  assert.equal(withSlash.modelDiscoveryEnabled, true);
  assert.equal(withSlash.inferenceModels[0].labelOverride, undefined);

  const interactive = buildClaudeDesktopProfile(oidcProfile, {
    credentialMode: "interactive",
    clientId: "my-client",
    oidcScopes: "openid profile",
    oidcRedirectPort: 53181,
    oidcBearerTokenType: "id_token",
    oidcAppendOfflineAccess: false,
    oidcAuthFlow: "broker",
  });
  assert.equal(interactive.inferenceCredentialKind, "interactive");
  assert.equal(interactive.inferenceGatewayApiKey, undefined);
  assert.equal(interactive.inferenceGatewayOidcAuthFlow, "broker");
  assert.equal(interactive.inferenceGatewayOidc.clientId, "my-client");
  assert.equal(interactive.inferenceGatewayOidc.scopes, "openid profile");
  assert.equal(interactive.inferenceGatewayOidc.redirectPort, 53181);
  assert.equal(interactive.inferenceGatewayOidc.bearerTokenType, "id_token");
  assert.equal(interactive.inferenceGatewayOidc.appendOfflineAccess, false);
});

test("Claude Desktop static mode without token is refused", () => {
  const oidcProfile = {
    ...anthropicProfile,
    requiresAuth: true,
    auth: {
      required: true,
      preferred: {
        kind: "openid-connect",
        issuer: "https://idp.example.com/realms/demo",
      },
    },
  };
  assert.throws(
    () => buildClaudeDesktopProfile(oidcProfile, { credentialMode: "static" }),
    /needs a bearer token/,
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

// ---------------------------------------------------------------------------
// Install detection. The filesystem is injected so these never stat ~/.
// ---------------------------------------------------------------------------

const REAL_HOME = homedir();
const FAKE_HOME = "/tmp/kong-ai-switch-detect";
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

function lookupDouble({ entries = {}, plists = {}, dirs = {} } = {}) {
  const calls = [];
  const guard = (file) => {
    calls.push(file);
    if (file === REAL_HOME || file.startsWith(`${REAL_HOME}${path.sep}`)) {
      throw new Error(`lookup touched the real home: ${file}`);
    }
  };
  return {
    calls,
    async stat(file) {
      guard(file);
      const kind = entries[file];
      if (!kind) return null;
      return {
        isFile: () => kind === "file",
        isDirectory: () => kind === "dir",
      };
    },
    async readFile(file) {
      guard(file);
      if (!Object.hasOwn(plists, file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = "ENOENT";
        throw error;
      }
      const body = plists[file];
      return Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
    async listDir(dir) {
      guard(dir);
      return dirs[dir] ?? [];
    },
  };
}

function plistXml(bundleId) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`
  );
}

async function detect(id, spec = {}) {
  const fs = lookupDouble(spec);
  const found = await detectInstall(id, {
    home: spec.home ?? FAKE_HOME,
    platform: spec.platform ?? "darwin",
    pathEnv: spec.pathEnv ?? "",
    stat: fs.stat,
    readFile: fs.readFile,
    listDir: fs.listDir,
  });
  return { ...found, calls: fs.calls };
}

async function runCli(args, home) {
  try {
    const out = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 15000,
    });
    return { code: 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("a binary on the explicit search path counts, ahead of PATH and config files", async () => {
  const home = FAKE_HOME;
  const found = await detect("claude-code", {
    home,
    pathEnv: "/custom/bin",
    entries: {
      "/opt/homebrew/bin/claude": "file",
      "/usr/local/bin/claude": "file",
      [path.join(home, ".local", "bin", "claude")]: "file",
      "/custom/bin/claude": "file",
      [path.join(home, ".claude", "settings.json")]: "file",
    },
  });
  assert.equal(found.installed, true);
  assert.equal(found.foundAt, "/opt/homebrew/bin/claude");
});

test("Claude Code's native installer counts when no binary is on the search path", async () => {
  const home = FAKE_HOME;
  const local = path.join(home, ".claude", "local");
  const found = await detect("claude-code", {
    home,
    entries: {
      [local]: "dir",
      [path.join(home, ".claude", "settings.json")]: "file",
    },
  });
  assert.equal(found.foundAt, local);
});

test("version-manager shims are searched before PATH", async () => {
  const home = FAKE_HOME;
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  const newest = path.join(nvmRoot, "v22.11.0", "bin", "codex");
  const found = await detect("codex", {
    home,
    pathEnv: "/custom/bin",
    entries: {
      [newest]: "file",
      [path.join(nvmRoot, "v20.0.0", "bin", "codex")]: "file",
      "/custom/bin/codex": "file",
      [path.join(home, ".codex", "config.toml")]: "file",
    },
    dirs: { [nvmRoot]: ["v20.0.0", "v22.11.0"] },
  });
  assert.equal(found.foundAt, newest);

  const asdf = path.join(home, ".asdf", "shims", "codex");
  assert.equal((await detect("codex", { home, entries: { [asdf]: "file" } })).foundAt, asdf);

  const fnm = path.join(home, ".fnm", "current", "bin", "claude");
  assert.equal((await detect("claude-code", { home, entries: { [fnm]: "file" } })).foundAt, fnm);

  const volta = path.join(home, ".volta", "bin", "copilot");
  assert.equal((await detect("github-copilot", { home, entries: { [volta]: "file" } })).foundAt, volta);
});

test("PATH is used only after the explicit directories miss", async () => {
  const home = FAKE_HOME;
  const found = await detect("github-copilot", {
    home,
    pathEnv: "/custom/bin",
    entries: {
      "/custom/bin/copilot": "file",
      [path.join(home, ".copilot", "settings.json")]: "file",
      [path.join(home, ".copilot", "kong-ai-switch.env")]: "file",
    },
  });
  assert.equal(found.installed, true);
  assert.equal(found.foundAt, "/custom/bin/copilot");
});

test("Claude Desktop is Claude.app with the Anthropic bundle id", async () => {
  const home = FAKE_HOME;
  const app = "/Applications/Claude.app";
  const plistPath = path.join(app, "Contents", "Info.plist");
  const library = path.join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
  const found = await detect("claude-desktop", {
    home,
    entries: { [app]: "dir", [plistPath]: "file", [library]: "dir" },
    plists: { [plistPath]: plistXml("com.anthropic.claudefordesktop") },
  });
  assert.equal(found.foundAt, app);

  const wrong = await detect("claude-desktop", {
    home,
    entries: { [app]: "dir", [plistPath]: "file" },
    plists: { [plistPath]: plistXml("com.example.not-claude") },
  });
  assert.equal(wrong.installed, false);
  assert.equal(wrong.foundAt, null);

  const userApp = path.join(home, "Applications", "Claude.app");
  const userPlist = path.join(userApp, "Contents", "Info.plist");
  const binaryPlist = Buffer.concat([
    Buffer.from("bplist00"),
    Buffer.from("CFBundleIdentifier"),
    Buffer.from("com.anthropic.claudefordesktop"),
  ]);
  const atHome = await detect("claude-desktop", {
    home,
    entries: { [userApp]: "dir", [userPlist]: "file" },
    plists: { [userPlist]: binaryPlist },
  });
  assert.equal(atHome.foundAt, userApp);
});

test("config files this tool writes do not count as an install", async () => {
  const home = FAKE_HOME;
  const entries = {
    [path.join(home, ".claude", "settings.json")]: "file",
    [path.join(home, "Library", "Application Support", "Claude-3p", "configLibrary")]: "dir",
    [path.join(home, ".codex", "config.toml")]: "file",
    [path.join(home, ".copilot", "settings.json")]: "file",
    [path.join(home, ".copilot", "kong-ai-switch.env")]: "file",
    [path.join(home, ".kong-ai-switch", "cursor-local.env")]: "file",
    [path.join(home, ".hermes")]: "dir",
    [path.join(home, ".hermes", "config.yaml")]: "file",
    [path.join(home, ".openclaw", "openclaw.json")]: "file",
  };
  for (const id of [
    "claude-code",
    "claude-desktop",
    "codex",
    "github-copilot",
    "cursor",
    "hermes",
    "openclaw",
  ]) {
    const found = await detect(id, { home, entries });
    assert.equal(found.installed, false, id);
    assert.equal(found.foundAt, null, id);
  }
});

test("stock Cursor paths are not Cursor Private Inference", async () => {
  const cursor = getAgent("cursor");
  assert.deepEqual(cursor.install.ignoreBinaries, ["cursor", "cursor-agent"]);
  assert.deepEqual(cursor.install.ignoreApps, ["Cursor.app"]);
  assert.match(cursor.install.note, /No stable public install path/);
  const home = FAKE_HOME;
  const found = await detect("cursor", {
    home,
    entries: {
      "/Applications/Cursor.app": "dir",
      [path.join(home, "Applications", "Cursor.app")]: "dir",
      "/opt/homebrew/bin/cursor": "file",
      "/usr/local/bin/cursor-agent": "file",
      [path.join(home, ".local", "bin", "cursor")]: "file",
      [path.join(home, ".kong-ai-switch", "cursor-local.env")]: "file",
    },
  });
  assert.equal(found.installed, false);
  assert.equal(found.foundAt, null);
});

test("Hermes is the binary, the hermes-agent checkout, or the app — not the data dir", async () => {
  const home = FAKE_HOME;
  const bin = path.join(home, ".local", "bin", "hermes");
  assert.equal(
    (await detect("hermes", { home, entries: { [bin]: "file", [path.join(home, ".hermes")]: "dir" } })).foundAt,
    bin,
  );

  const checkout = path.join(home, ".hermes", "hermes-agent");
  assert.equal(
    (await detect("hermes", { home, entries: { [checkout]: "dir", [path.join(home, ".hermes")]: "dir" } })).foundAt,
    checkout,
  );

  const app = path.join(home, "Applications", "Hermes.app");
  assert.equal((await detect("hermes", { home, entries: { [app]: "dir" } })).foundAt, app);

  const linux = await detect("hermes", { home, platform: "linux", entries: { [app]: "dir" } });
  assert.equal(linux.installed, false);

  const prev = process.env.HERMES_HOME;
  const relocated = "/tmp/kong-ai-switch-hermes-home";
  process.env.HERMES_HOME = relocated;
  try {
    const found = await detect("hermes", {
      home,
      entries: {
        [relocated]: "dir",
        [path.join(home, ".hermes")]: "dir",
        [path.join(home, ".hermes", "config.yaml")]: "file",
      },
    });
    assert.equal(found.installed, false);
    assert.equal(found.calls.includes(relocated), false);
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  }
});

test("OpenClaw is the binary or ~/.openclaw, not OPENCLAW_CONFIG_PATH", async () => {
  const home = FAKE_HOME;
  const bin = "/usr/local/bin/openclaw";
  assert.equal((await detect("openclaw", { home, entries: { [bin]: "file" } })).foundAt, bin);

  const root = path.join(home, ".openclaw");
  assert.equal((await detect("openclaw", { home, entries: { [root]: "dir" } })).foundAt, root);

  const prev = process.env.OPENCLAW_CONFIG_PATH;
  const decoy = "/tmp/kong-ai-switch-openclaw.json";
  process.env.OPENCLAW_CONFIG_PATH = decoy;
  try {
    const found = await detect("openclaw", {
      home,
      entries: {
        [decoy]: "file",
        [path.join(home, ".openclaw", "openclaw.json")]: "file",
      },
    });
    assert.equal(found.installed, false);
    assert.equal(found.foundAt, null);
    assert.equal(found.calls.includes(decoy), false);
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = prev;
  }
});

test("agents text and json report installed, foundAt, and switchable", () => {
  const rows = [
    describeAgent(
      getAgent("claude-code"),
      { file: "/x/.claude/settings.json", configured: true, model: "my-claude", baseUrl: "http://gw" },
      { installed: true, foundAt: "/opt/homebrew/bin/claude" },
    ),
    describeAgent(
      getAgent("codex"),
      { file: "/x/.codex/config.toml", configured: false },
      { installed: false, foundAt: null },
    ),
    describeAgent(
      getAgent("hermes"),
      { file: "/x/.hermes/hermes-agent", configured: false },
      { installed: true, foundAt: "/x/.local/bin/hermes" },
    ),
  ];
  assert.equal(rows[0].installed, true);
  assert.equal(rows[0].foundAt, "/opt/homebrew/bin/claude");
  assert.equal(rows[0].switchable, true);
  assert.equal(rows[0].model, "my-claude");
  assert.equal(rows[1].installed, false);
  assert.equal(rows[1].foundAt, null);
  assert.equal(rows[2].switchable, false);
  const text = formatAgentsTable(rows);
  assert.match(text, /not installed/);
  assert.match(text, /my-claude/);
  assert.match(text, /not switchable/);
});

test("detected-only agents are not offered as switch targets", () => {
  const { supported, unsupported } = agentsForModel("openai");
  assert.equal(supported.some((agent) => agent.id === "hermes" || agent.id === "openclaw"), false);
  assert.equal(unsupported.some((agent) => agent.id === "hermes" || agent.id === "openclaw"), false);
  assert.ok(supported.some((agent) => agent.id === "codex"));
});

test("hermes and openclaw are detected but use and applyToAgent refuse them", async () => {
  const home = await scratchHome();
  await assert.rejects(() => applyToAgent("hermes", openaiProfile, { home }), /not switchable yet/);
  await assert.rejects(() => applyToAgent("openclaw", openaiProfile, { home }), /not switchable yet/);
  assert.deepEqual(await readdir(home), []);

  for (const agent of ["hermes", "openclaw"]) {
    const result = await runCli(["use", "some-model", "--agent", agent], home);
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(`${result.stderr}\n${result.stdout}`, /not switchable yet/);
  }

  const mixed = await runCli(["use", "some-model", "--agent", "hermes,claude-code"], home);
  assert.notEqual(mixed.code, 0);
  assert.match(mixed.stderr, /not switchable yet/);

  const unknown = await runCli(["use", "some-model", "--agent", "emacs"], home);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown agent/);
  assert.match(unknown.stderr, /Known agents/);

  assert.deepEqual(await readdir(home), []);
  await assert.rejects(() => readFile(path.join(home, ".hermes", "config.yaml"), "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(path.join(home, ".claude", "settings.json"), "utf8"), /ENOENT/);
});
