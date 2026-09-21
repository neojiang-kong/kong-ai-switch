/**
 * Tests for the Kong entity -> switch profile translation.
 *
 * Fixtures mirror the shapes documented in the Konnect AI Gateway API
 * (OAS 2.0.3) and the official "Route Claude CLI traffic through AI Gateway
 * and Anthropic" guide.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  gatewayOrigin,
  modelRoutePath,
  modelFormat,
  clientModelId,
  modelSelector,
  buildProfiles,
  toProfile,
} from "../src/kong/models.js";

const gateway = {
  id: "bf138ba2-c9b1-4229-b268-04d9d8a6410b",
  name: "ai-quickstart",
  display_name: "My AI Gateway",
  deployment_type: "hybrid",
  proxy_urls: [{ host: "localhost", port: 8000, protocol: "http" }],
};

/** The model from Kong's own Claude Code tutorial. */
const claudeModel = {
  name: "my-claude",
  display_name: "my-claude",
  type: "model",
  enabled: true,
  formats: [{ type: "anthropic" }],
  capabilities: ["generate"],
  config: {
    route: { paths: ["/"], model: { body_param: "model", values: ["my-claude"] } },
  },
  targets: [{ name: "claude-opus-4-8", provider: "generic-anthropic", weight: 100 }],
  policies: [],
};

test("gatewayOrigin builds an origin from proxy_urls", () => {
  assert.equal(gatewayOrigin(gateway), "http://localhost:8000");
});

test("gatewayOrigin omits default ports and prefers https", () => {
  const g = {
    proxy_urls: [
      { host: "a.example.com", port: 80, protocol: "http" },
      { host: "b.example.com", port: 443, protocol: "https" },
    ],
  };
  assert.equal(gatewayOrigin(g), "https://b.example.com");
});

test("gatewayOrigin returns null when no proxy URL is published", () => {
  assert.equal(gatewayOrigin({ proxy_urls: [] }), null);
  assert.equal(gatewayOrigin({}), null);
});

test('route path "/" contributes no suffix', () => {
  assert.equal(modelRoutePath(claudeModel), "");
});

test("route path is normalized and stripped of trailing slashes", () => {
  assert.equal(modelRoutePath({ config: { route: { paths: ["/team-a/"] } } }), "/team-a");
  assert.equal(modelRoutePath({ config: { route: { paths: ["team-a"] } } }), "/team-a");
});

test("format defaults to openai when unset", () => {
  assert.equal(modelFormat({}), "openai");
  assert.equal(modelFormat(claudeModel), "anthropic");
});

test("clientModelId prefers the route alias over the entity name", () => {
  assert.equal(clientModelId(claudeModel), "my-claude");

  const aliased = {
    name: "internal-name",
    config: { route: { model: { body_param: "model", values: ["production-chat"] } } },
  };
  assert.equal(clientModelId(aliased), "production-chat");
});

test("clientModelId falls back to the entity name with no routing rule", () => {
  assert.equal(clientModelId({ name: "bare-model" }), "bare-model");
});

test("modelSelector reports where the alias must be sent", () => {
  assert.deepEqual(modelSelector(claudeModel), { kind: "body", param: "model" });
  assert.deepEqual(
    modelSelector({ config: { route: { model: { header_param: "x-model" } } } }),
    { kind: "header", param: "x-model" },
  );
  assert.deepEqual(modelSelector({}), { kind: "body", param: "model" });
});

test("an anthropic-format model maps to the Messages endpoint", () => {
  const { profile } = toProfile(claudeModel, gateway);
  // Claude Code appends /v1/messages itself, so the base URL stops here.
  assert.equal(profile.baseUrl, "http://localhost:8000");
  assert.equal(profile.endpoint, "http://localhost:8000/v1/messages");
  assert.equal(profile.clientModelId, "my-claude");
  assert.equal(profile.format, "anthropic");
});

test("an openai-format model maps to /chat/completions", () => {
  const openaiModel = {
    ...claudeModel,
    name: "my-gpt",
    formats: [{ type: "openai" }],
    config: { route: { paths: ["/openai"] } },
  };
  const { profile } = toProfile(openaiModel, gateway);
  assert.equal(profile.baseUrl, "http://localhost:8000/openai");
  assert.equal(profile.endpoint, "http://localhost:8000/openai/chat/completions");
});

test("the client model id is the AI Model name, never the upstream id", () => {
  const { profile } = toProfile(claudeModel, gateway);
  assert.equal(profile.clientModelId, "my-claude");
  assert.notEqual(profile.clientModelId, "claude-opus-4-8");
  assert.equal(profile.targets[0].model, "claude-opus-4-8");
});

test("models without generate capability are skipped with a reason", () => {
  const embeddings = { ...claudeModel, name: "embed", capabilities: ["embeddings"] };
  const { profile, skipped } = toProfile(embeddings, gateway);
  assert.equal(profile, null);
  assert.match(skipped.reason, /generate/);
});

test("disabled models are skipped", () => {
  const { profile, skipped } = toProfile({ ...claudeModel, enabled: false }, gateway);
  assert.equal(profile, null);
  assert.match(skipped.reason, /disabled/);
});

test("batch api models are skipped", () => {
  const api = { ...claudeModel, type: "api", capabilities: ["batches"] };
  const { profile, skipped } = toProfile(api, gateway);
  assert.equal(profile, null);
  assert.match(skipped.reason, /batch/);
});

test("a gateway with no proxy URL yields no profile", () => {
  const { profile, skipped } = toProfile(claudeModel, { ...gateway, proxy_urls: [] });
  assert.equal(profile, null);
  assert.match(skipped.reason, /data plane URL/);
});

test("a caller-supplied origin substitutes for a missing proxy URL", () => {
  const bare = { ...gateway, proxy_urls: [] };
  const { profile } = toProfile(claudeModel, bare, { origin: "https://ai.corp.example" });
  assert.equal(profile.baseUrl, "https://ai.corp.example");
});

test("a caller-supplied origin overrides a published proxy URL", () => {
  const { profile } = toProfile(claudeModel, gateway, { origin: "https://edge.corp.example/" });
  assert.equal(profile.baseUrl, "https://edge.corp.example");
});

test("openai-format models are flagged as unusable from Claude Code", () => {
  const openaiModel = { ...claudeModel, name: "my-gpt", formats: [{ type: "openai" }] };
  const { profile } = toProfile(openaiModel, gateway);
  assert.equal(profile.claudeCode.ok, false);
  assert.match(profile.claudeCode.reason, /Anthropic Messages API/);
});

test("anthropic-format models are usable regardless of upstream vendor", () => {
  // Kong translates, so an OpenAI target behind an anthropic format is fine.
  const translated = {
    ...claudeModel,
    targets: [{ name: "gpt-5", provider: "openai-prod", weight: 100 }],
  };
  const { profile } = toProfile(translated, gateway);
  assert.equal(profile.claudeCode.ok, true);
  assert.equal(profile.targets[0].model, "gpt-5");
});

test("auth strategies are surfaced so the CLI can demand a token", () => {
  const guarded = { ...claudeModel, access: { auth_strategies: ["okta-ai-se"] } };
  const { profile } = toProfile(guarded, gateway);
  assert.equal(profile.requiresAuth, true);
  assert.equal(toProfile(claudeModel, gateway).profile.requiresAuth, false);
});

test("buildProfiles sorts and partitions usable from skipped", () => {
  const models = [
    { ...claudeModel, name: "zeta", display_name: "Zeta" },
    { ...claudeModel, name: "alpha", display_name: "Alpha" },
    { ...claudeModel, name: "nope", capabilities: ["embeddings"] },
  ];
  const { profiles, skipped } = buildProfiles(models, gateway);
  assert.deepEqual(profiles.map((p) => p.displayName), ["Alpha", "Zeta"]);
  assert.equal(skipped.length, 1);
});
