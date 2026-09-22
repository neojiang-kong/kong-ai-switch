/**
 * Tests for per-environment catalogue storage, including the v1 migration.
 *
 * The property that matters: syncing one environment must never disturb
 * another's cached models.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readState,
  writeState,
  environmentState,
  putEnvironmentState,
  dropEnvironmentState,
  resolveProfile,
} from "../src/config/store.js";

async function scratchFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "kong-ai-switch-state-"));
  return path.join(dir, "state.json");
}

const profile = (name, gatewayName = "GW") => ({
  id: `g:${name}`,
  name,
  displayName: name,
  gatewayName,
  baseUrl: "http://localhost:8000",
  clientModelId: name,
  targets: [],
});

test("an unsynced environment reads as empty, not undefined", () => {
  const entry = environmentState({ environments: {} }, "mine");
  assert.deepEqual(entry.profiles, []);
  assert.equal(entry.syncedAt, null);
});

test("syncing one environment leaves the others untouched", () => {
  let state = { version: 2, environments: {} };
  state = putEnvironmentState(state, "mine", { profiles: [profile("a")], syncedAt: "t1" });
  state = putEnvironmentState(state, "customer", { profiles: [profile("b")], syncedAt: "t2" });

  // Re-sync one; the other must survive intact.
  state = putEnvironmentState(state, "mine", { profiles: [profile("a2")], syncedAt: "t3" });

  assert.deepEqual(environmentState(state, "mine").profiles.map((p) => p.name), ["a2"]);
  assert.deepEqual(environmentState(state, "customer").profiles.map((p) => p.name), ["b"]);
  assert.equal(environmentState(state, "customer").syncedAt, "t2");
});

test("dropping an environment removes only its catalogue", () => {
  let state = { version: 2, environments: {} };
  state = putEnvironmentState(state, "mine", { profiles: [profile("a")] });
  state = putEnvironmentState(state, "customer", { profiles: [profile("b")] });

  const next = dropEnvironmentState(state, "customer");
  assert.equal(next.environments.customer, undefined);
  assert.deepEqual(environmentState(next, "mine").profiles.map((p) => p.name), ["a"]);
});

test("state round-trips through disk", async () => {
  const file = await scratchFile();
  const state = putEnvironmentState({ version: 2, environments: {} }, "mine", {
    profiles: [profile("a")],
    syncedAt: "t1",
  });
  await writeState(state, file);

  const loaded = await readState(file);
  assert.equal(loaded.version, 2);
  assert.deepEqual(environmentState(loaded, "mine").profiles.map((p) => p.name), ["a"]);
});

test("a v1 state file is carried forward rather than discarded", async () => {
  const file = await scratchFile();
  // The shape written before environments existed.
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      syncedAt: "2026-01-01T00:00:00Z",
      region: "us",
      gateways: [{ id: "g1" }],
      profiles: [profile("legacy")],
      current: "g:legacy",
    }),
    "utf8",
  );

  const loaded = await readState(file, { migrateInto: "default" });
  assert.equal(loaded.version, 2);
  const entry = environmentState(loaded, "default");
  assert.deepEqual(entry.profiles.map((p) => p.name), ["legacy"]);
  assert.equal(entry.current, "g:legacy");
  assert.equal(entry.region, "us");
});

test("a corrupt state file degrades to empty instead of throwing", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ not json", "utf8");
  const loaded = await readState(file);
  assert.deepEqual(loaded.environments, {});
});

test("resolveProfile reports ambiguity instead of guessing", () => {
  const profiles = [
    { ...profile("shared"), id: "g1:shared", gatewayName: "GW1" },
    { ...profile("shared"), id: "g2:shared", gatewayName: "GW2" },
  ];
  const { profile: found, error } = resolveProfile(profiles, "shared");
  assert.equal(found, null);
  assert.match(error, /exists on 2 gateways/);
});

test("resolveProfile accepts a fully qualified id", () => {
  const profiles = [
    { ...profile("shared"), id: "g1:shared", gatewayName: "GW1" },
    { ...profile("shared"), id: "g2:shared", gatewayName: "GW2" },
  ];
  const { profile: found } = resolveProfile(profiles, "g2:shared");
  assert.equal(found.gatewayName, "GW2");
});
