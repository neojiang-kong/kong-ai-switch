/**
 * Tests for AI Auth Strategy handling.
 *
 * Fixtures mirror strategies observed on a real Konnect gateway: a key-auth
 * strategy with the default `apikey` header, Keycloak OIDC strategies using
 * bearer tokens, and models that accept either.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  keyAuthHeader,
  describeStrategy,
  describeModelAuth,
  credentialHeader,
  authWithKind,
  AUTH_KIND,
} from "../src/kong/auth.js";

const keyAuth = {
  name: "api-key",
  display_name: "API Key",
  type: "key-auth",
  config: { key_names: ["apikey"] },
};

const oidc = {
  name: "keycloak-oidc",
  display_name: "Keycloak",
  type: "openid-connect",
  config: {
    issuer: "https://kong-care-keycloak.kongapj.com/realms/care",
    auth_methods: ["bearer"],
  },
};

const byName = new Map([
  ["api-key", keyAuth],
  ["keycloak-oidc", oidc],
]);

test("key-auth defaults to the apikey header", () => {
  assert.equal(keyAuthHeader(keyAuth), "apikey");
  assert.equal(keyAuthHeader({ type: "key-auth" }), "apikey");
});

test("key-auth honours a custom key name", () => {
  assert.equal(keyAuthHeader({ config: { key_names: ["X-API-Key"] } }), "X-API-Key");
});

test("a key-auth strategy is storable", () => {
  const described = describeStrategy(keyAuth);
  assert.equal(described.kind, AUTH_KIND.KEY_AUTH);
  assert.equal(described.header, "apikey");
  // A long-lived key is worth keeping in the Keychain.
  assert.equal(described.storable, true);
});

test("an OIDC strategy is not storable and reports its issuer", () => {
  const described = describeStrategy(oidc);
  assert.equal(described.kind, AUTH_KIND.OIDC);
  assert.equal(described.header, "Authorization");
  // Access tokens expire; a stored one would fail mid-session.
  assert.equal(described.storable, false);
  assert.match(described.issuer, /realms\/care/);
  assert.match(described.hint, /expires/);
});

test("an unknown strategy type is reported, not guessed at", () => {
  const described = describeStrategy({ name: "weird", type: "mtls" });
  assert.equal(described.kind, "mtls");
  assert.equal(described.storable, false);
});

test("a model with no strategies needs no credential", () => {
  const auth = describeModelAuth({}, byName);
  assert.equal(auth.required, false);
  assert.equal(auth.kind, AUTH_KIND.NONE);
  assert.equal(credentialHeader(auth), null);
});

test("a key-auth-only model prefers key-auth", () => {
  const model = { access: { auth_strategies: ["api-key"] } };
  const auth = describeModelAuth(model, byName);
  assert.equal(auth.required, true);
  assert.equal(auth.kind, AUTH_KIND.KEY_AUTH);
  assert.equal(credentialHeader(auth), "apikey");
  assert.equal(auth.hasChoice, false);
});

test("an OIDC-only model reports OIDC", () => {
  const model = { access: { auth_strategies: ["keycloak-oidc"] } };
  const auth = describeModelAuth(model, byName);
  assert.equal(auth.kind, AUTH_KIND.OIDC);
  assert.equal(credentialHeader(auth), "Authorization");
});

test("a model accepting either prefers the storable one", () => {
  // Observed on a real gateway: claudecode accepts api-key OR keycloak-oidc.
  const model = { access: { auth_strategies: ["api-key", "keycloak-oidc"] } };
  const auth = describeModelAuth(model, byName);

  assert.equal(auth.hasChoice, true);
  assert.equal(auth.strategies.length, 2);
  // Key-auth wins: it is the one this tool can hold for the user.
  assert.equal(auth.preferred.kind, AUTH_KIND.KEY_AUTH);
  assert.equal(credentialHeader(auth), "apikey");
});

test("OIDC listed first still yields key-auth as preferred", () => {
  const model = { access: { auth_strategies: ["keycloak-oidc", "api-key"] } };
  assert.equal(describeModelAuth(model, byName).preferred.kind, AUTH_KIND.KEY_AUTH);
});

test("a strategy that could not be read is still named", () => {
  const model = { access: { auth_strategies: ["care-keycloak"] } };
  const auth = describeModelAuth(model, new Map());
  assert.equal(auth.required, true);
  assert.equal(auth.strategies[0].name, "care-keycloak");
  assert.equal(auth.strategies[0].kind, "unknown");
});

test("authWithKind switches the preferred strategy", () => {
  const model = { access: { auth_strategies: ["api-key", "keycloak-oidc"] } };
  const auth = describeModelAuth(model, byName);
  const oidc = authWithKind(auth, AUTH_KIND.OIDC);
  assert.equal(oidc.preferred.kind, AUTH_KIND.OIDC);
  assert.equal(credentialHeader(oidc), "Authorization");
});
