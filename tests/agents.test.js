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
  assert.ok(ids.includes("github-copilot"));
  assert.deepEqual(getAgent("claude-code").formats, ["anthropic"]);
  assert.deepEqual(getAgent("codex").formats, ["openai"]);
  assert.deepEqual(getAgent("github-copilot").formats, ["openai", "anthropic"]);
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
  assert.equal(body.inferenceGatewayBaseUrl, "http://localhost:8000/");
  assert.equal(body.inferenceCredentialKind, "static");
  assert.equal(body.inferenceModels[0].name, "my-claude");
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
  assert.equal(status.baseUrl, "http://localhost:8000/");
});

test("Claude Desktop OIDC uses interactive browser login with issuer", async () => {
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
  assert.equal(body.inferenceCredentialKind, "interactive");
  assert.equal(body.inferenceGatewayOidcAuthFlow, "browser");
  assert.equal(body.inferenceGatewayOidc.issuer, "https://idp.example.com/realms/demo");
  assert.equal(body.inferenceGatewayOidc.clientId, "claude-desktop");
  assert.equal(body.inferenceGatewayOidc.redirectPort, 53180);
  // Interactive must not also set a static API key — that breaks Desktop's 3P UI.
  assert.equal(body.inferenceGatewayApiKey, undefined);
  assert.equal(body.inferenceGatewayAuthScheme, undefined);
});

test("Claude Desktop Entra OIDC takes client id from JWT azp, never claude-desktop", async () => {
  const home = await scratchHome();
  // Minimal unsigned JWT payload for the test: {"azp":"20167183-7ef7-48f2-9763-1d30199e32a9"}
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
  assert.equal(body.inferenceGatewayOidc.clientId, "20167183-7ef7-48f2-9763-1d30199e32a9");
  assert.equal(body.inferenceGatewayApiKey, undefined);
});

test("Claude Desktop Entra OIDC without client id fails clearly", async () => {
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

test("malformed JSON is refused rather than overwritten", async () => {
  const home = await scratchHome();
  await mkdir(path.join(home, ".claude"), { recursive: true });
  const file = path.join(home, ".claude", "settings.json");
  await writeFile(file, "{ broken", "utf8");

  await assert.rejects(() => applyToAgent("claude-code", anthropicProfile, { home }), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{ broken");
});
