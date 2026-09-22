/**
 * Tests for named environments.
 *
 * The scenario driving these: an SE with their own org, a demo org, and a
 * customer org, moving between them without losing state or leaking a token
 * from one into another.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readConfig,
  writeConfig,
  putEnvironment,
  removeEnvironment,
  setActive,
  listEnvironments,
  resolveEnvironment,
  toShareable,
  fromShareable,
  validateName,
  validateRegion,
  validateProxyUrl,
  ConfigError,
} from "../src/config/environments.js";

async function scratchFile(basename = "config.json") {
  const dir = await mkdtemp(path.join(tmpdir(), "kong-ai-switch-cfg-"));
  return path.join(dir, basename);
}

const EMPTY = { version: 1, active: null, environments: {} };

test("names are restricted to safe characters", () => {
  assert.equal(validateName("customer-acme"), "customer-acme");
  assert.equal(validateName("demo.us_2"), "demo.us_2");
  assert.throws(() => validateName("has space"), ConfigError);
  assert.throws(() => validateName("../escape"), ConfigError);
  assert.throws(() => validateName(""), ConfigError);
});

test("regions accept known keys or a full control plane URL", () => {
  assert.equal(validateRegion("EU"), "eu");
  assert.equal(validateRegion("https://cp.internal.example/v1/"), "https://cp.internal.example/v1");
  assert.throws(() => validateRegion("mars"), ConfigError);
});

test("proxy URLs are validated when the environment is defined", () => {
  assert.equal(validateProxyUrl("http://localhost:8000/"), "http://localhost:8000");
  assert.equal(validateProxyUrl(null), null);
  assert.throws(() => validateProxyUrl("not a url"), ConfigError);
  assert.throws(() => validateProxyUrl("ftp://host"), ConfigError);
});

test("the first environment added becomes active", () => {
  const config = putEnvironment(EMPTY, { name: "mine", region: "us" });
  assert.equal(config.active, "mine");
});

test("adding a second environment does not steal the active slot", () => {
  let config = putEnvironment(EMPTY, { name: "mine", region: "us" });
  config = putEnvironment(config, { name: "customer", region: "eu" });
  assert.equal(config.active, "mine");
  assert.equal(listEnvironments(config).length, 2);
});

test("environments keep their own region and proxy URL", () => {
  let config = putEnvironment(EMPTY, {
    name: "mine",
    region: "us",
    proxyUrl: "http://localhost:8000",
  });
  config = putEnvironment(config, {
    name: "customer",
    region: "eu",
    proxyUrl: "https://ai.acme.example",
  });

  assert.equal(config.environments.mine.region, "us");
  assert.equal(config.environments.customer.region, "eu");
  assert.equal(config.environments.customer.proxyUrl, "https://ai.acme.example");
});

test("updating one field leaves the others alone", () => {
  let config = putEnvironment(EMPTY, {
    name: "mine",
    region: "us",
    proxyUrl: "http://localhost:8000",
    description: "my own org",
  });
  config = putEnvironment(config, { name: "mine", region: "eu" });

  assert.equal(config.environments.mine.region, "eu");
  assert.equal(config.environments.mine.proxyUrl, "http://localhost:8000");
  assert.equal(config.environments.mine.description, "my own org");
});

test("createdAt survives an update while updatedAt moves", async () => {
  const first = putEnvironment(EMPTY, { name: "mine", region: "us" });
  const created = first.environments.mine.createdAt;
  await new Promise((r) => setTimeout(r, 2));
  const second = putEnvironment(first, { name: "mine", region: "eu" });
  assert.equal(second.environments.mine.createdAt, created);
  assert.notEqual(second.environments.mine.updatedAt, created);
});

test("removing the active environment promotes another deterministically", () => {
  let config = putEnvironment(EMPTY, { name: "beta", region: "us" });
  config = putEnvironment(config, { name: "alpha", region: "us" });
  assert.equal(config.active, "beta");

  const next = removeEnvironment(config, "beta");
  assert.equal(next.active, "alpha");
  assert.equal(next.environments.beta, undefined);
});

test("removing the last environment leaves no dangling active pointer", () => {
  const config = putEnvironment(EMPTY, { name: "only", region: "us" });
  const next = removeEnvironment(config, "only");
  assert.equal(next.active, null);
});

test("removing an unknown environment is an error, not a silent no-op", () => {
  assert.throws(() => removeEnvironment(EMPTY, "ghost"), ConfigError);
});

test("setActive rejects an unknown name", () => {
  const config = putEnvironment(EMPTY, { name: "mine", region: "us" });
  assert.throws(() => setActive(config, "ghost"), ConfigError);
});

test("an explicit request overrides the active environment", () => {
  let config = putEnvironment(EMPTY, { name: "mine", region: "us" });
  config = putEnvironment(config, { name: "customer", region: "eu" });

  assert.equal(resolveEnvironment(config, undefined).name, "mine");
  assert.equal(resolveEnvironment(config, "customer").name, "customer");
});

test("a single environment resolves without being marked active", () => {
  const config = { ...EMPTY, environments: { solo: { name: "solo", region: "us" } } };
  assert.equal(resolveEnvironment(config, undefined).name, "solo");
});

test("resolving with none defined explains how to create one", () => {
  assert.throws(() => resolveEnvironment(EMPTY, undefined), /env add/);
});

test("resolving an unknown name lists what is defined", () => {
  const config = putEnvironment(EMPTY, { name: "mine", region: "us" });
  assert.throws(() => resolveEnvironment(config, "ghost"), /Defined: mine/);
});

test("export strips credentials", () => {
  const config = putEnvironment(EMPTY, {
    name: "customer",
    region: "eu",
    proxyUrl: "https://ai.acme.example",
    token: "kpat_secret",
  });
  const shared = toShareable(config.environments.customer);

  assert.equal(shared.region, "eu");
  assert.equal(shared.proxyUrl, "https://ai.acme.example");
  // The token must be absent, not blanked, so it cannot leak via an export.
  assert.equal("token" in shared, false);
  assert.equal(JSON.stringify(shared).includes("kpat_secret"), false);
});

test("import round-trips an export", () => {
  const config = putEnvironment(EMPTY, {
    name: "customer",
    region: "eu",
    proxyUrl: "https://ai.acme.example",
    description: "Acme POC",
  });
  const shared = JSON.stringify(toShareable(config.environments.customer));
  const parsed = fromShareable(shared);

  assert.equal(parsed.name, "customer");
  assert.equal(parsed.region, "eu");
  assert.equal(parsed.description, "Acme POC");
});

test("import can rename to avoid a collision", () => {
  const shared = toShareable({ name: "customer", region: "eu", proxyUrl: null });
  const parsed = fromShareable(JSON.stringify(shared), { name: "acme-poc" });
  assert.equal(parsed.name, "acme-poc");
});

test("import rejects a file that is not an environment export", () => {
  assert.throws(() => fromShareable('{"hello":"world"}'), /not a kong-ai-switch environment export/);
  assert.throws(() => fromShareable("not json"), /not valid JSON/);
});

test("import validates the region it is given", () => {
  const bad = JSON.stringify({ kind: "kong-ai-switch/environment", name: "x", region: "mars" });
  assert.throws(() => fromShareable(bad), ConfigError);
});

test("config round-trips through disk", async () => {
  const file = await scratchFile();
  let config = putEnvironment(EMPTY, { name: "mine", region: "us", proxyUrl: "http://localhost:8000" });
  config = putEnvironment(config, { name: "customer", region: "eu" });
  await writeConfig(config, file);

  const loaded = await readConfig(file);
  assert.equal(loaded.active, "mine");
  assert.equal(Object.keys(loaded.environments).length, 2);
  assert.equal(loaded.environments.customer.region, "eu");
});

test("a missing config reads as empty", async () => {
  const file = await scratchFile();
  const config = await readConfig(file);
  assert.deepEqual(config.environments, {});
});

test("a malformed config is refused rather than overwritten", async () => {
  const file = await scratchFile();
  await writeFile(file, "{ broken", "utf8");
  await assert.rejects(() => readConfig(file), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{ broken");
});
