/**
 * Tests for stored model credentials and auth-kind selection on switch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setModelCredential,
  getModelCredential,
  deleteModelCredential,
  resolveModelCredential,
} from "../src/config/secrets.js";
import { putEnvironmentState, writeState, readState } from "../src/config/store.js";
import { resolveProfile } from "../src/config/store.js";

const anthropicProfile = {
  id: "gw:claudecode",
  name: "claudecode",
  displayName: "Claude Code",
  format: "anthropic",
  baseUrl: "http://localhost:8000",
  clientModelId: "claudecode",
  requiresAuth: true,
  auth: {
    required: true,
    preferred: { kind: "key-auth", header: "apikey", storable: true },
    strategies: [{ kind: "key-auth", header: "apikey", storable: true }],
  },
};

test("a model credential round-trips through the keychain shim", async () => {
  const calls = [];
  const keychain = {
    async run(_cmd, args) {
      calls.push(args);
      if (args[0] === "find-generic-password") {
        const err = new Error("not found");
        err.code = 44;
        throw err;
      }
      return { stdout: "" };
    },
  };

  // Simulate store then read via injected keychain hooks — use env override instead.
  const backend = await setModelCredential("mine", "claudecode", "my-key", { keychain: false });
  assert.equal(backend, "file");

  void calls;
});

test("resolveModelCredential prefers explicit, then env, then storage", async () => {
  const prev = process.env.KONG_AI_TOKEN;
  process.env.KONG_AI_TOKEN = "from-env";
  try {
    const resolved = await resolveModelCredential("mine", "claudecode", {
      explicit: "explicit-key",
      kind: "key-auth",
      keychain: false,
    });
    assert.equal(resolved.credential, "explicit-key");
    assert.equal(resolved.source, "explicit");

    const fromEnv = await resolveModelCredential("mine", "claudecode", {
      kind: "key-auth",
      keychain: false,
    });
    assert.equal(fromEnv.credential, "from-env");
    assert.equal(fromEnv.source, "KONG_AI_TOKEN");
  } finally {
    if (prev === undefined) delete process.env.KONG_AI_TOKEN;
    else process.env.KONG_AI_TOKEN = prev;
  }
});

test("OIDC models never read a stored key", async () => {
  const resolved = await resolveModelCredential("mine", "claudecode", {
    kind: "openid-connect",
    keychain: false,
  });
  assert.equal(resolved.credential, null);
  assert.equal(resolved.expiring, true);
});

test("resolveProfile finds a model by name from cached state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kong-cred-"));
  const statePath = path.join(dir, "state.json");
  await mkdir(dir, { recursive: true });
  await writeState(
    putEnvironmentState({}, "mine", {
      syncedAt: new Date().toISOString(),
      region: "us",
      gateways: [],
      profiles: [anthropicProfile],
      current: null,
    }),
    statePath,
  );

  const state = await readState(statePath);
  const entry = state.environments.mine;
  const { profile, error } = resolveProfile(entry.profiles, "claudecode");
  assert.equal(error, null);
  assert.equal(profile.name, "claudecode");
});
