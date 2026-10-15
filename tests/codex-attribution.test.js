/**
 * Tests for Codex cost-attribution headers.
 *
 * The properties that matter most: the managed `[model_providers.kong]` block
 * stays valid TOML that keeps the key-auth credential, and nothing the user
 * writes before or after it is pulled into a header table.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, chmod, appendFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentStatus,
  applyCodexAttribution,
  applyCodexAttributionToToml,
  applyToAgent,
  parseTomlInlineStringTable,
} from "../src/config/agents.js";
import {
  ATTRIBUTION_AGENTS,
  CODEX_BRANCH_ENV,
  buildCodexAttributionWrapper,
  describeAttribution,
  normalizeAttribution,
  normalizeStoredAttribution,
  putAgentAttribution,
  readAgentAttribution,
} from "../src/config/attribution.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.js");

const keyAuthProfile = {
  name: "my-gpt",
  displayName: "GPT-5",
  format: "openai",
  baseUrl: "http://localhost:8000/openai",
  clientModelId: "my-gpt",
  requiresAuth: true,
  auth: { required: true, preferred: { kind: "key-auth", header: "apikey" } },
};

const codexAttribution = normalizeAttribution(
  {
    enabled: true,
    project: "payments-api",
    branch: "main",
    headers: [{ name: "ai-cost-team", value: "platform" }],
  },
  "codex",
);

const HAS_TOMLLIB = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

/** Parse with a real TOML implementation, not our own regexes. */
function parseToml(text) {
  const result = spawnSync(
    "python3",
    ["-c", "import sys, json, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    { input: text, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`Invalid TOML:\n${result.stderr}\n---\n${text}`);
  return JSON.parse(result.stdout);
}

async function scratchHome() {
  return mkdtemp(path.join(tmpdir(), "kong-codex-attr-"));
}

async function codexHome(userToml) {
  const home = await scratchHome();
  await mkdir(path.join(home, ".codex"), { recursive: true });
  if (userToml) await writeFile(path.join(home, ".codex", "config.toml"), userToml);
  return home;
}

const USER_TOML = [
  "disable_response_storage = true",
  "",
  '[projects."/Users/example/demo"]',
  'trust_level = "trusted"',
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Tag model and records
// ---------------------------------------------------------------------------

test("Codex reports its own tags; only branch and project need headers", () => {
  const codex = ATTRIBUTION_AGENTS.codex;
  assert.deepEqual(codex.autoSent.map((t) => t.tag), [
    "Agent session",
    "Agent request kind",
    "Repository",
    "Source control provider",
    "Commit",
    "Agent ID",
    "Parent agent",
    "Agent type",
  ]);
  assert.ok(codex.autoSent.every((t) => !t.needsHintHeaders));
  assert.deepEqual(codex.fields, ["branch", "project"]);
  assert.equal(codex.hintHeaders, false);
  assert.deepEqual(ATTRIBUTION_AGENTS["claude-code"].fields, ["scmProvider", "repository", "branch"]);
});

test("a Codex record never carries the fields Codex sends itself", () => {
  const record = normalizeAttribution(
    { enabled: true, scmProvider: "github", repository: "acme/x", repositoryAuto: true, hintHeaders: true },
    "codex",
  );
  assert.equal(record.scmProvider, "");
  assert.equal(record.repository, "");
  assert.equal(record.repositoryAuto, false);
  assert.equal(record.hintHeaders, false);

  assert.throws(
    () => normalizeAttribution({ headers: [{ name: "ai-cost-scm-provider", value: "github" }] }, "codex"),
    /Codex sends the source control provider itself/,
  );
  assert.throws(
    () => normalizeAttribution({ headers: [{ name: "ai-cost-project", value: "p" }] }, "codex"),
    /use --project or --branch/,
  );
  assert.throws(
    () => normalizeAttribution({ headers: [{ name: "ai-cost-project", value: "p" }] }),
    /use --project, --scm-provider, --repository or --branch/,
  );
});

test("the 0.2.8 single-record shape is read as Claude Code and migrated losslessly", () => {
  const legacy = { enabled: true, project: "old", scmProvider: "github", headers: [] };
  assert.equal(readAgentAttribution(legacy, "claude-code").project, "old");
  assert.equal(readAgentAttribution(legacy, "codex").enabled, false);

  const stored = putAgentAttribution(legacy, "codex", codexAttribution);
  assert.deepEqual(Object.keys(stored), ["claudeCode", "codex"]);
  assert.equal(stored.claudeCode, legacy);
  assert.equal(readAgentAttribution(stored, "codex").project, "payments-api");

  assert.deepEqual(Object.keys(putAgentAttribution(stored, "claude-code", null)), ["codex"]);
  assert.equal(putAgentAttribution(putAgentAttribution(stored, "codex", null), "claude-code", null), null);

  const imported = normalizeStoredAttribution(legacy);
  assert.equal(imported.claudeCode.project, "old");
  assert.equal(imported.codex, undefined);
});

test("describe groups Codex attribution by the tags Kong reports", () => {
  const info = describeAttribution(
    normalizeAttribution({ enabled: true, project: "p", branchAuto: true, headers: [{ name: "x-team", value: "a" }] }, "codex"),
    { home: "/Users/x", agent: "codex" },
  );
  assert.equal(info.agent, "codex");
  assert.equal(info.hintHeaders, false);
  assert.equal(info.tags.autoSent.length, 8);
  assert.deepEqual(info.tags.fromHeaders, [
    { tag: "Branch", header: "ai-cost-scm-branch", value: null, source: "git: git branch --show-current" },
    { tag: "Project", header: "ai-cost-project", value: "p", source: "fixed" },
  ]);
  assert.deepEqual(info.tags.additional, [{ label: null, header: "x-team", value: "a" }]);
  assert.deepEqual(info.dynamicHeaders, [
    { name: "ai-cost-scm-branch", source: "git branch --show-current", env: CODEX_BRANCH_ENV },
  ]);
  assert.equal(info.wrapperFile, "/Users/x/.kong-ai-switch/codex-attribution.sh");
  assert.equal(
    info.sourceLine,
    '[ -f "$HOME/.kong-ai-switch/codex-attribution.sh" ] && source "$HOME/.kong-ai-switch/codex-attribution.sh"',
  );
});

// ---------------------------------------------------------------------------
// config.toml
// ---------------------------------------------------------------------------

test("inline header tables parse, including quoted keys and escapes", () => {
  assert.deepEqual(parseTomlInlineStringTable('{ apikey = "k", "x.y" = \'v\', z = "a\\"b\\u0041" }'), [
    { name: "apikey", value: "k" },
    { name: "x.y", value: "v" },
    { name: "z", value: 'a"bA' },
  ]);
  assert.deepEqual(parseTomlInlineStringTable("{}"), []);
  assert.throws(() => parseTomlInlineStringTable("{ a.b = 1 }"), /Unsupported/);
});

test("static Codex attribution joins the key-auth credential in http_headers", { skip: !HAS_TOMLLIB }, async () => {
  const home = await codexHome(USER_TOML);
  const result = await applyToAgent("codex", keyAuthProfile, { home, token: "my-key", attribution: codexAttribution });
  const text = await readFile(result.file, "utf8");
  const toml = parseToml(text);

  const kong = toml.model_providers.kong;
  assert.deepEqual(kong.http_headers, {
    apikey: "my-key",
    "ai-cost-project": "payments-api",
    "ai-cost-scm-branch": "main",
    "ai-cost-team": "platform",
  });
  assert.equal(kong.env_http_headers, undefined);
  assert.match(text, /http_headers = \{ apikey = "my-key", ai-cost-project = /);
  assert.doesNotMatch(text, /\[model_providers\.kong\.http_headers\]/);
  // User keys stay where they were.
  assert.equal(toml.disable_response_storage, true);
  assert.equal(toml.projects["/Users/example/demo"].trust_level, "trusted");
  assert.equal(toml.model_provider, "kong");
  assert.equal(result.attribution.enabled, true);
  assert.equal(result.attribution.wrapperActive, false);
});

test("auto branch maps an env var through env_http_headers and writes the wrapper", { skip: !HAS_TOMLLIB }, async () => {
  const home = await codexHome(USER_TOML);
  const auto = normalizeAttribution({ enabled: true, project: "p", branchAuto: true }, "codex");
  const result = await applyToAgent("codex", keyAuthProfile, { home, token: "k", attribution: auto, environment: "acme" });
  const kong = parseToml(await readFile(result.file, "utf8")).model_providers.kong;
  assert.deepEqual(kong.http_headers, { apikey: "k", "ai-cost-project": "p" });
  assert.deepEqual(kong.env_http_headers, { "ai-cost-scm-branch": CODEX_BRANCH_ENV });

  assert.equal(result.attribution.wrapperActive, true);
  const wrapper = await readFile(path.join(home, ".kong-ai-switch", "codex-attribution.sh"), "utf8");
  assert.match(wrapper, /# Environment: acme/);
  assert.match(wrapper, /KONG_AI_SCM_BRANCH="\$_kas_v" command codex "\$@"/);
});

test("re-applying and disabling touch only attribution entries; later user tables survive", { skip: !HAS_TOMLLIB }, async () => {
  const home = await codexHome(USER_TOML);
  const first = normalizeAttribution(
    { enabled: true, project: "p1", branchAuto: true, headers: [{ name: "x-old", value: "1" }] },
    "codex",
  );
  const { file } = await applyToAgent("codex", keyAuthProfile, { home, token: "k", attribution: first });
  // A user table appended after the managed block must stay its own table.
  await appendFile(file, "\n[tui]\nnotifications = true\n");

  const second = normalizeAttribution({ enabled: true, project: "p2", branch: "dev" }, "codex");
  const reapplied = await applyCodexAttribution({
    attribution: second,
    previous: first,
    credentialHeader: "apikey",
    home,
  });
  assert.equal(reapplied.applied, true);
  let toml = parseToml(await readFile(file, "utf8"));
  assert.deepEqual(toml.model_providers.kong.http_headers, {
    apikey: "k",
    "ai-cost-project": "p2",
    "ai-cost-scm-branch": "dev",
  });
  assert.equal(toml.model_providers.kong.env_http_headers, undefined);
  assert.deepEqual(toml.tui, { notifications: true });
  assert.equal(toml.disable_response_storage, true);

  // Disabling with no `previous` still finds the custom names via the marker.
  await applyCodexAttribution({ attribution: null, credentialHeader: "apikey", home });
  const text = await readFile(file, "utf8");
  toml = parseToml(text);
  assert.deepEqual(toml.model_providers.kong.http_headers, { apikey: "k" });
  assert.doesNotMatch(text, /kong-ai-switch attribution headers/);
  assert.deepEqual(toml.tui, { notifications: true });
  assert.equal((await agentStatus("codex", { home })).hasToken, true);
});

test("attribution headers alone do not count as a Codex credential", async () => {
  const home = await codexHome();
  const openProfile = { ...keyAuthProfile, requiresAuth: false, auth: { required: false } };
  await applyToAgent("codex", openProfile, { home, attribution: codexAttribution });
  const status = await agentStatus("codex", { home });
  assert.equal(status.configured, true);
  assert.equal(status.hasToken, false);
});

test("header names that are not bare TOML keys are quoted, never dotted", { skip: !HAS_TOMLLIB }, async () => {
  const home = await codexHome();
  const record = normalizeAttribution({ enabled: true, headers: [{ name: "x.cost~center", value: 'a "q"' }] }, "codex");
  const { file } = await applyToAgent("codex", keyAuthProfile, { home, token: "k", attribution: record });
  const kong = parseToml(await readFile(file, "utf8")).model_providers.kong;
  assert.deepEqual(kong.http_headers, { apikey: "k", "x.cost~center": 'a "q"' });
});

test("re-applying without a managed provider block reports not applied", async () => {
  const home = await codexHome(USER_TOML);
  const result = await applyCodexAttribution({ attribution: codexAttribution, home });
  assert.equal(result.applied, false);
  assert.equal(applyCodexAttributionToToml(USER_TOML, codexAttribution), null);
});

// ---------------------------------------------------------------------------
// Shell wrapper
// ---------------------------------------------------------------------------

function hasShell(shell) {
  return spawnSync(shell, ["-c", "true"]).status === 0;
}

async function fakeCodex(dir) {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const file = path.join(bin, "codex");
  await writeFile(
    file,
    `#!/bin/sh\nexec node -e 'process.stdout.write(JSON.stringify({b: process.env.${CODEX_BRANCH_ENV} ?? null, argv: process.argv.slice(1)}))' -- "$@"\n`,
  );
  await chmod(file, 0o755);
  return bin;
}

for (const shell of ["bash", "zsh"]) {
  test(`the codex wrapper exports the git branch when sourced in ${shell}`, { skip: !hasShell(shell) }, async () => {
    const dir = await scratchHome();
    const repo = path.join(dir, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "feature/attr"], { cwd: repo });
    const bin = await fakeCodex(dir);
    const wrapper = path.join(dir, "wrapper.sh");
    await writeFile(
      wrapper,
      buildCodexAttributionWrapper(normalizeAttribution({ enabled: true, branchAuto: true }, "codex")),
    );
    const run = (cwd) =>
      JSON.parse(
        execFileSync(shell, ["-c", `source "${wrapper}" && codex exec hi`], {
          cwd,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: dir },
          encoding: "utf8",
        }),
      );
    assert.deepEqual(run(repo), { b: "feature/attr", argv: ["exec", "hi"] });
    // Outside a repo the variable stays unset, so Codex omits the header.
    assert.deepEqual(run(dir), { b: null, argv: ["exec", "hi"] });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cliHome(attribution) {
  const home = await scratchHome();
  await mkdir(path.join(home, ".kong-ai-switch"), { recursive: true });
  await writeFile(
    path.join(home, ".kong-ai-switch", "config.json"),
    JSON.stringify({
      version: 1,
      active: "acme",
      environments: { acme: { name: "acme", region: "us", proxyUrl: null, ...(attribution ? { attribution } : {}) } },
    }),
  );
  return home;
}

function cli(home, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, KONNECT_TOKEN: "" },
    encoding: "utf8",
  });
  let json = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    // Human output.
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

async function readConfigFile(home) {
  return JSON.parse(await readFile(path.join(home, ".kong-ai-switch", "config.json"), "utf8"));
}

test("the CLI refuses Claude-only flags for Codex with a clear reason", async () => {
  const home = await cliHome();
  for (const [args, pattern] of [
    [["--scm-provider", "github"], /Codex sends the source control provider itself/],
    [["--repository", "auto"], /Codex sends the repository itself/],
    [["--hint-headers", "false"], /Claude Code setting/],
  ]) {
    const result = cli(home, ["attribution", "set", "--agent", "codex", ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  }
  const unknown = cli(home, ["attribution", "show", "--agent", "copilot"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--agent claude-code or codex/);
});

test("Codex attribution is stored beside a migrated Claude Code record", async () => {
  const legacy = { enabled: true, hintHeaders: true, project: "claude-proj", scmProvider: "github", headers: [] };
  const home = await cliHome(legacy);

  const set = cli(home, [
    "attribution", "set", "--agent", "codex", "--project", "payments-api", "--branch", "auto",
    "--header", "ai-cost-team: platform", "--json",
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.json.agent, "codex");
  assert.equal(set.json.needsWrapper, true);
  assert.match(set.json.sourceLine, /codex-attribution\.sh/);
  assert.equal(set.json.agents["claude-code"].attribution.project, "claude-proj");
  assert.equal(set.json.agents.codex.attribution.project, "payments-api");

  let config = await readConfigFile(home);
  assert.equal(config.environments.acme.attribution.claudeCode.project, "claude-proj");
  assert.equal(config.environments.acme.attribution.codex.branchAuto, true);

  // Default agent is still Claude Code, with the 0.2.8 fields at the top level.
  const shown = cli(home, ["attribution", "show", "--json"]);
  assert.equal(shown.json.agent, "claude-code");
  assert.equal(shown.json.attribution.project, "claude-proj");
  assert.equal(shown.json.hintHeaders, true);

  const human = cli(home, ["attribution", "show", "--agent", "codex"]).stdout;
  assert.match(human, /Sent by Codex automatically/);
  assert.match(human, /From the headers you add:\n\s+Branch\s+ai-cost-scm-branch\s+auto from git/);
  assert.match(human, /\s+Project\s+ai-cost-project\s+payments-api/);
  assert.doesNotMatch(human, /gateway hint headers/);

  const cleared = cli(home, ["attribution", "clear", "--agent", "codex", "--json"]);
  assert.equal(cleared.json.attribution.enabled, false);
  config = await readConfigFile(home);
  assert.deepEqual(Object.keys(config.environments.acme.attribution), ["claudeCode"]);
});

test("env export/import carries per-agent attribution", async () => {
  const home = await cliHome({
    claudeCode: { enabled: true, project: "c" },
    codex: { enabled: true, project: "x", branchAuto: true },
  });
  const file = path.join(home, "acme.json");
  assert.equal(cli(home, ["env", "export", "acme", "--out", file]).status, 0);
  const imported = cli(home, ["env", "import", file, "--name", "copy"]);
  assert.equal(imported.status, 0, imported.stderr);
  const config = await readConfigFile(home);
  assert.equal(config.environments.copy.attribution.claudeCode.project, "c");
  assert.equal(config.environments.copy.attribution.codex.project, "x");
  assert.equal(config.environments.copy.attribution.codex.branchAuto, true);
});
