/**
 * Tests for Claude Code cost-attribution headers.
 *
 * The property that matters most: attribution must coexist with the key-auth
 * credential in ANTHROPIC_CUSTOM_HEADERS and never drop it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, chmod, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyToAgent, applyClaudeAttribution, getAgent } from "../src/config/agents.js";
import {
  AttributionError,
  applyAttributionToEnv,
  attributionWrapperPath,
  buildAttributionWrapper,
  describeAttribution,
  mergeCustomHeaders,
  normalizeAttribution,
  normalizeRepoUrl,
  parseHeaderLine,
  readAttribution,
  staticAttributionHeaders,
  validateHeaderName,
  validateHeaderValue,
} from "../src/config/attribution.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.js");

const keyAuthProfile = {
  name: "my-claude",
  displayName: "Claude Opus",
  format: "anthropic",
  baseUrl: "http://localhost:8000",
  clientModelId: "my-claude",
  requiresAuth: true,
  auth: { required: true, preferred: { kind: "key-auth", header: "apikey" } },
};

const oidcProfile = {
  ...keyAuthProfile,
  auth: { required: true, preferred: { kind: "openid-connect", header: "Authorization" } },
};

const fullAttribution = normalizeAttribution({
  enabled: true,
  project: "payments-api",
  scmProvider: "github",
  repository: "acme/payments-api",
  branch: "main",
  headers: [{ name: "ai-cost-team", value: "platform" }],
});

async function scratchHome() {
  return mkdtemp(path.join(tmpdir(), "kong-attr-"));
}

async function readSettings(home) {
  return JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("header names must be HTTP tokens", () => {
  assert.equal(validateHeaderName("  ai-cost-team "), "ai-cost-team");
  assert.equal(validateHeaderName("X_Custom.1~"), "X_Custom.1~");
  assert.throws(() => validateHeaderName("bad name"), AttributionError);
  assert.throws(() => validateHeaderName("bad:name"), AttributionError);
  assert.throws(() => validateHeaderName("naïve"), AttributionError);
  assert.throws(() => validateHeaderName(""), AttributionError);
});

test("header values are trimmed and must be a single line", () => {
  assert.equal(validateHeaderValue("  payments-api  "), "payments-api");
  assert.equal(validateHeaderValue("trailing newline\n"), "trailing newline");
  assert.throws(() => validateHeaderValue("two\nlines"), /single line/);
  assert.throws(() => validateHeaderValue("cr\rhere"), /single line/);
  assert.throws(() => validateHeaderValue("bell\u0007"), /control/);
});

test("header lines parse as Name: value", () => {
  assert.deepEqual(parseHeaderLine("ai-cost-team:  platform "), { name: "ai-cost-team", value: "platform" });
  assert.deepEqual(parseHeaderLine("x-url: https://a/b"), { name: "x-url", value: "https://a/b" });
  assert.throws(() => parseHeaderLine("no colon"), AttributionError);
  assert.throws(() => parseHeaderLine(": empty name"), AttributionError);
});

test("extra headers cannot claim credential or known attribution names", () => {
  for (const name of ["apikey", "Authorization", "x-api-key"]) {
    assert.throws(
      () => normalizeAttribution({ enabled: true, headers: [{ name, value: "x" }] }),
      /credential/,
    );
  }
  assert.throws(
    () => normalizeAttribution({ enabled: true, headers: [{ name: "ai-cost-project", value: "x" }] }),
    /own setting/,
  );
});

test("a corrupt stored record is cleaned rather than failing a switch", () => {
  const record = readAttribution({
    enabled: true,
    project: "pay\nments",
    headers: [{ name: "bad name", value: "x" }, { name: "ai-cost-team", value: "a\nb" }],
  });
  assert.equal(record.project, "pay ments");
  assert.deepEqual(record.headers, [{ name: "ai-cost-team", value: "a b" }]);
});

test("auto fields drop any fixed value", () => {
  const record = normalizeAttribution({ enabled: true, repository: "x/y", repositoryAuto: true });
  assert.equal(record.repository, "");
  assert.deepEqual(staticAttributionHeaders(record), []);
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test("attribution merges after the apikey credential header", () => {
  const block = mergeCustomHeaders("apikey: secret", fullAttribution, { credentialHeader: "apikey" });
  assert.equal(
    block,
    [
      "apikey: secret",
      "ai-cost-project: payments-api",
      "ai-cost-scm-provider: github",
      "ai-cost-scm-repository: acme/payments-api",
      "ai-cost-scm-branch: main",
      "ai-cost-team: platform",
    ].join("\n"),
  );
});

test("a stale record naming the credential header never drops it", () => {
  const stale = { headers: [{ name: "X-Gateway-Key", value: "old" }] };
  const block = mergeCustomHeaders("X-Gateway-Key: secret\nai-cost-project: old", fullAttribution, {
    credentialHeader: "X-Gateway-Key",
    previous: stale,
  });
  assert.match(block, /^X-Gateway-Key: secret$/m);
  assert.doesNotMatch(block, /ai-cost-project: old/);
  assert.match(block, /ai-cost-project: payments-api/);
});

test("previous extra headers are removed when the record changes", () => {
  const previous = normalizeAttribution({ enabled: true, headers: [{ name: "x-old", value: "1" }] });
  const block = mergeCustomHeaders("apikey: k\nx-old: 1", fullAttribution, {
    credentialHeader: "apikey",
    previous,
  });
  assert.doesNotMatch(block, /x-old/);
  assert.match(block, /^apikey: k$/m);
});

test("hint flag follows the toggle and is removed when disabled", () => {
  const env = {};
  applyAttributionToEnv(env, fullAttribution);
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");

  applyAttributionToEnv(env, { ...fullAttribution, hintHeaders: false });
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined);

  applyAttributionToEnv(env, { ...fullAttribution, enabled: false });
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("the hint key is owned by the Claude Code writer", () => {
  assert.ok(getAgent("claude-code").ownedKeys.includes("CLAUDE_CODE_GATEWAY_HINT_HEADERS"));
});

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

test("a key-auth switch writes credential and attribution together", async () => {
  const home = await scratchHome();
  await applyToAgent("claude-code", keyAuthProfile, { home, token: "my-key", attribution: fullAttribution });
  const { env } = await readSettings(home);

  const lines = env.ANTHROPIC_CUSTOM_HEADERS.split("\n");
  assert.equal(lines[0], "apikey: my-key");
  assert.ok(lines.includes("ai-cost-project: payments-api"));
  assert.ok(lines.includes("ai-cost-team: platform"));
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "kong-ai-gateway");
});

test("an OIDC switch sends attribution without a credential header", async () => {
  const home = await scratchHome();
  await applyToAgent("claude-code", oidcProfile, { home, token: "bearer", attribution: fullAttribution });
  const { env } = await readSettings(home);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "bearer");
  assert.ok(env.ANTHROPIC_CUSTOM_HEADERS.startsWith("ai-cost-project: payments-api"));
  assert.doesNotMatch(env.ANTHROPIC_CUSTOM_HEADERS, /apikey/);
});

test("disabling attribution removes its keys but keeps the credential", async () => {
  const home = await scratchHome();
  await writeFile(path.join(await mkdirp(home, ".claude"), "settings.json"), JSON.stringify({ env: { KEEP_ME: "1" } }));
  await applyToAgent("claude-code", keyAuthProfile, { home, token: "my-key", attribution: fullAttribution });
  await applyToAgent("claude-code", keyAuthProfile, {
    home,
    token: "my-key",
    attribution: { ...fullAttribution, enabled: false },
  });
  const { env } = await readSettings(home);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "apikey: my-key");
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined);
  assert.equal(env.KEEP_ME, "1");
});

test("re-applying attribution in place keeps the credential and drops old extras", async () => {
  const home = await scratchHome();
  const previous = normalizeAttribution({ enabled: true, project: "old", headers: [{ name: "x-old", value: "1" }] });
  await applyToAgent("claude-code", keyAuthProfile, { home, token: "my-key", attribution: previous });

  await applyClaudeAttribution({ home, attribution: fullAttribution, previous, credentialHeader: "apikey" });
  let { env } = await readSettings(home);
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /^apikey: my-key\n/);
  assert.doesNotMatch(env.ANTHROPIC_CUSTOM_HEADERS, /x-old|ai-cost-project: old/);
  assert.equal(env.ANTHROPIC_MODEL, "my-claude");

  await applyClaudeAttribution({ home, attribution: null, previous: fullAttribution, credentialHeader: "apikey" });
  ({ env } = await readSettings(home));
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "apikey: my-key");
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined);
});

test("static attribution writes no wrapper file", async () => {
  const home = await scratchHome();
  const result = await applyToAgent("claude-code", keyAuthProfile, { home, token: "k", attribution: fullAttribution });
  assert.equal(result.attribution.wrapperActive, false);
  await assert.rejects(stat(attributionWrapperPath(home)), { code: "ENOENT" });
});

test("auto git fields write an owner-only wrapper; disabling neutralises it", async () => {
  const home = await scratchHome();
  const auto = normalizeAttribution({ enabled: true, project: "p", repositoryAuto: true, branchAuto: true });
  const result = await applyToAgent("claude-code", keyAuthProfile, { home, token: "k", attribution: auto });
  assert.equal(result.attribution.wrapperActive, true);

  const file = attributionWrapperPath(home);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const body = await readFile(file, "utf8");
  assert.match(body, /claude\(\) \{/);
  assert.match(body, /_kas_h='apikey: k\nai-cost-project: p'/);

  // settings.json only carries what is static.
  const { env } = await readSettings(home);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "apikey: k\nai-cost-project: p");

  await applyToAgent("claude-code", keyAuthProfile, { home, token: "k", attribution: null });
  const stub = await readFile(file, "utf8");
  assert.doesNotMatch(stub, /claude\(\) \{/);
  assert.match(stub, /no wrapper is needed/);
});

// ---------------------------------------------------------------------------
// Repository URL normalisation
// ---------------------------------------------------------------------------

const REPO_CASES = [
  ["https://github.com/acme/payments-api.git", "acme/payments-api"],
  ["https://github.com/acme/payments-api", "acme/payments-api"],
  ["https://github.com/acme/payments-api/", "acme/payments-api"],
  ["https://user:tok@github.com/acme/payments-api.git", "acme/payments-api"],
  ["git@github.com:acme/payments-api.git", "acme/payments-api"],
  ["ssh://git@github.com/acme/payments-api.git", "acme/payments-api"],
  ["ssh://git@gitlab.example.com:2222/group/sub/repo.git", "group/sub/repo"],
  ["https://dev.azure.com/org/project/_git/repo", "org/project/repo"],
  ["git@ssh.dev.azure.com:v3/org/project/repo", "org/project/repo"],
  ["", ""],
];

test("repository URLs normalise to the owner/repo path", () => {
  for (const [url, expected] of REPO_CASES) {
    assert.equal(normalizeRepoUrl(url), expected, url);
  }
});

// ---------------------------------------------------------------------------
// Wrapper content and behaviour
// ---------------------------------------------------------------------------

test("wrapper content embeds static headers and computes git values at launch", () => {
  const auto = normalizeAttribution({ enabled: true, project: "it's", repositoryAuto: true, branchAuto: true });
  const body = buildAttributionWrapper(auto, { staticBlock: "apikey: k\nai-cost-project: it's", environment: "acme" });
  assert.match(body, /^# >>> kong-ai-switch \(managed\) >>>/);
  assert.match(body, /# Environment: acme/);
  assert.match(body, /git remote get-url origin/);
  assert.match(body, /git branch --show-current/);
  assert.match(body, /ai-cost-scm-repository: \$\{_kas_v\}/);
  assert.match(body, /ai-cost-scm-branch: \$\{_kas_v\}/);
  // Single quotes in static values are shell-escaped.
  assert.match(body, /_kas_h='apikey: k\nai-cost-project: it'\\''s'/);
  assert.match(body, /_kas_j='apikey: k\\nai-cost-project: it'\\''s'/);
  assert.match(body, /ANTHROPIC_CUSTOM_HEADERS="\$_kas_h" command claude/);
});

test("describe reports the preview and the source line only when needed", () => {
  const info = describeAttribution(fullAttribution, { home: "/Users/x" });
  assert.equal(info.needsWrapper, false);
  assert.equal(info.sourceLine, null);
  assert.match(info.preview, /^ai-cost-project: payments-api$/m);

  const auto = describeAttribution(normalizeAttribution({ enabled: true, branchAuto: true }), { home: "/Users/x" });
  assert.equal(auto.needsWrapper, true);
  assert.equal(auto.sourceLine, '[ -f "$HOME/.kong-ai-switch/claude-attribution.sh" ] && source "$HOME/.kong-ai-switch/claude-attribution.sh"');
  assert.match(auto.preview, /ai-cost-scm-branch: \$\(git branch --show-current\)/);
});

test("describe groups attribution by the tags Kong reports", () => {
  const info = describeAttribution({ ...fullAttribution, branchAuto: true, branch: "" });
  assert.deepEqual(
    info.tags.autoSent.map((t) => [t.tag, t.needsHintHeaders, t.sent]),
    [
      ["Agent session", false, true],
      ["Agent ID", false, true],
      ["Parent agent", false, true],
      ["Agent request kind", true, true],
      ["Agent type", true, true],
    ],
  );
  assert.deepEqual(info.tags.fromHeaders, [
    { tag: "Source control provider", header: "ai-cost-scm-provider", value: "github", source: "fixed" },
    { tag: "Repository", header: "ai-cost-scm-repository", value: "acme/payments-api", source: "fixed" },
    { tag: "Branch", header: "ai-cost-scm-branch", value: null, source: "git: git branch --show-current" },
  ]);
  assert.deepEqual(info.tags.additional, [
    { label: "Project", header: "ai-cost-project", value: "payments-api" },
    { label: null, header: "ai-cost-team", value: "platform" },
  ]);

  const noHints = describeAttribution({ ...fullAttribution, hintHeaders: false });
  assert.deepEqual(noHints.tags.autoSent.filter((t) => !t.sent).map((t) => t.tag), ["Agent request kind", "Agent type"]);

  const off = describeAttribution(normalizeAttribution({ project: "p", scmProvider: "github" }));
  assert.deepEqual(off.tags.fromHeaders.map((t) => t.value), [null, null, null]);
  assert.deepEqual(off.tags.additional, []);
});

async function mkdirp(...parts) {
  const dir = path.join(...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Fake `claude` that records its env var and argv as JSON. */
async function fakeClaude(dir) {
  const bin = await mkdirp(dir, "bin");
  const file = path.join(bin, "claude");
  await writeFile(
    file,
    `#!/bin/sh\nexec node -e 'process.stdout.write(JSON.stringify({h: process.env.ANTHROPIC_CUSTOM_HEADERS ?? null, argv: process.argv.slice(1)}))' -- "$@"\n`,
  );
  await chmod(file, 0o755);
  return bin;
}

function hasShell(shell) {
  return spawnSync(shell, ["-c", "true"]).status === 0;
}

for (const shell of ["bash", "zsh"]) {
  test(`the wrapper sends git-derived headers when sourced in ${shell}`, { skip: !hasShell(shell) }, async () => {
    const dir = await scratchHome();
    const repo = await mkdirp(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "feature/attr"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/payments-api.git"], { cwd: repo });
    const bin = await fakeClaude(dir);

    const auto = normalizeAttribution({ enabled: true, project: "payments", repositoryAuto: true, branchAuto: true });
    const wrapper = path.join(dir, "wrapper.sh");
    await writeFile(wrapper, buildAttributionWrapper(auto, { staticBlock: "apikey: k\nai-cost-project: payments" }));

    const out = execFileSync(shell, ["-c", `source "${wrapper}" && claude --print hi`], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    const { h, argv } = JSON.parse(out);
    const expected = [
      "apikey: k",
      "ai-cost-project: payments",
      "ai-cost-scm-repository: acme/payments-api",
      "ai-cost-scm-branch: feature/attr",
    ].join("\n");
    assert.equal(h, expected);
    assert.equal(argv[0], "--settings");
    assert.deepEqual(JSON.parse(argv[1]), { env: { ANTHROPIC_CUSTOM_HEADERS: expected } });
    assert.deepEqual(argv.slice(2), ["--print", "hi"]);
  });
}

test("the wrapper's shell URL normalisation matches the JS one", { skip: !hasShell("bash") }, async () => {
  const dir = await scratchHome();
  const wrapper = path.join(dir, "wrapper.sh");
  await writeFile(wrapper, buildAttributionWrapper(normalizeAttribution({ enabled: true, repositoryAuto: true })));
  for (const [url, expected] of REPO_CASES.filter(([u]) => u)) {
    const repo = await mkdtemp(path.join(dir, "r-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: repo });
    const out = execFileSync("bash", ["-c", `source "${wrapper}" && _kong_ai_switch_git_repo`], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(out, expected, url);
  }
});

test("outside a git repo the wrapper still launches with static headers", { skip: !hasShell("bash") }, async () => {
  const dir = await scratchHome();
  const bin = await fakeClaude(dir);
  const wrapper = path.join(dir, "wrapper.sh");
  const auto = normalizeAttribution({ enabled: true, project: "p", repositoryAuto: true, branchAuto: true });
  await writeFile(wrapper, buildAttributionWrapper(auto, { staticBlock: "ai-cost-project: p" }));
  const out = execFileSync("bash", ["-c", `source "${wrapper}" && claude`], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: dir },
    encoding: "utf8",
  });
  assert.equal(JSON.parse(out).h, "ai-cost-project: p");
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cliHome() {
  const home = await scratchHome();
  await mkdirp(home, ".kong-ai-switch");
  await writeFile(
    path.join(home, ".kong-ai-switch", "config.json"),
    JSON.stringify({ version: 1, active: "acme", environments: { acme: { name: "acme", region: "us", proxyUrl: null } } }),
  );
  return home;
}

function cli(home, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, KONNECT_TOKEN: "" },
    encoding: "utf8",
  });
  return { status: result.status, json: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

test("attribution set/show/clear round-trip through the CLI per environment", async () => {
  const home = await cliHome();
  const set = cli(home, [
    "attribution", "set", "--project", "payments-api", "--scm-provider", "GitHub",
    "--repository", "auto", "--branch=auto", "--header", "ai-cost-team: platform",
    "--header", "x-cost-center: 42", "--json",
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.json.attribution.enabled, true);
  assert.equal(set.json.attribution.scmProvider, "github");
  assert.equal(set.json.attribution.repositoryAuto, true);
  assert.equal(set.json.needsWrapper, true);
  assert.equal(set.json.applied, false);
  assert.deepEqual(set.json.attribution.headers.map((h) => h.name), ["ai-cost-team", "x-cost-center"]);

  const config = JSON.parse(await readFile(path.join(home, ".kong-ai-switch", "config.json"), "utf8"));
  assert.equal(config.environments.acme.attribution.project, "payments-api");

  const removed = cli(home, ["attribution", "set", "--remove-header", "x-cost-center", "--hint-headers", "false", "--json"]);
  assert.deepEqual(removed.json.attribution.headers.map((h) => h.name), ["ai-cost-team"]);
  assert.equal(removed.json.hintHeaders, false);
  assert.equal(removed.json.attribution.project, "payments-api");

  const shown = cli(home, ["attribution", "show", "--json"]);
  assert.equal(shown.json.environment, "acme");
  assert.ok(shown.json.scmProviders.includes("azure-devops"));
  assert.equal(shown.json.tags.autoSent.length, 5);
  assert.equal(shown.json.tags.fromHeaders[1].source, "git: git remote get-url origin");

  const human = spawnSync(process.execPath, [CLI, "attribution", "show"], {
    env: { ...process.env, HOME: home, KONNECT_TOKEN: "" },
    encoding: "utf8",
  }).stdout;
  assert.match(human, /Sent by Claude Code automatically/);
  assert.match(human, /Agent request kind\s+not sent: gateway hint headers off/);
  assert.match(human, /From the headers you add:\n\s+Source control provider\s+ai-cost-scm-provider\s+github/);
  assert.match(human, /Additional headers:\n\s+ai-cost-project\s+payments-api\n\s+ai-cost-team\s+platform/);

  const cleared = cli(home, ["attribution", "clear", "--json"]);
  assert.equal(cleared.json.attribution.enabled, false);
  const after = JSON.parse(await readFile(path.join(home, ".kong-ai-switch", "config.json"), "utf8"));
  assert.equal(after.environments.acme.attribution, undefined);
});

test("the CLI rejects invalid headers with a readable error", async () => {
  const home = await cliHome();
  const bad = cli(home, ["attribution", "set", "--header", "bad name: x", "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /not a valid HTTP header name/);

  const reserved = cli(home, ["attribution", "set", "--header", "apikey: x", "--json"]);
  assert.match(reserved.json.error, /credential/);
});
