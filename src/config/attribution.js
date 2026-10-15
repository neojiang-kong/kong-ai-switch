/**
 * AI cost-management attribution headers for Claude Code and Codex.
 *
 * Kong AI Gateway attributes spend by request headers (`ai-cost-project`,
 * `ai-cost-scm-*`, …). Claude Code sends extra headers from
 * ANTHROPIC_CUSTOM_HEADERS, one `Name: value` per line, and the request kind
 * and agent type when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1. Codex sends
 * `[model_providers.<id>].http_headers`, plus `env_http_headers` read from
 * the environment at launch; it reports repository, provider and commit
 * itself, so only branch and project need headers.
 *
 * Attribution is stored per environment in config.json, one record per agent
 * (`{ claudeCode, codex }`), so each Konnect org (or customer) can carry its
 * own project. Static values go straight into the agent's config file.
 * Git-derived values cannot be expressed there, so those go into a sourceable
 * shell wrapper.
 */

import { homedir } from "node:os";
import path from "node:path";

export const ATTRIBUTION_HEADERS = Object.freeze({
  project: "ai-cost-project",
  scmProvider: "ai-cost-scm-provider",
  repository: "ai-cost-scm-repository",
  branch: "ai-cost-scm-branch",
});

export const SCM_PROVIDERS = Object.freeze(["github", "gitlab", "bitbucket", "azure-devops", "other"]);

/**
 * Tags Kong AI cost management reports for Claude Code that the tool sends
 * itself. Request kind and agent type need CLAUDE_CODE_GATEWAY_HINT_HEADERS=1.
 */
export const AUTO_SENT_TAGS = Object.freeze([
  Object.freeze({ tag: "Agent session", needsHintHeaders: false }),
  Object.freeze({ tag: "Agent ID", needsHintHeaders: false }),
  Object.freeze({ tag: "Parent agent", needsHintHeaders: false }),
  Object.freeze({ tag: "Agent request kind", needsHintHeaders: true }),
  Object.freeze({ tag: "Agent type", needsHintHeaders: true }),
]);

/** Every attribution field, by the tag Kong reports it as. */
export const ATTRIBUTION_FIELDS = Object.freeze({
  scmProvider: Object.freeze({ tag: "Source control provider", key: "scmProvider", header: ATTRIBUTION_HEADERS.scmProvider }),
  repository: Object.freeze({ tag: "Repository", key: "repository", header: ATTRIBUTION_HEADERS.repository }),
  branch: Object.freeze({ tag: "Branch", key: "branch", header: ATTRIBUTION_HEADERS.branch }),
  project: Object.freeze({ tag: "Project", key: "project", header: ATTRIBUTION_HEADERS.project }),
});

/** Reported tags that come from headers you add (Claude Code). */
export const HEADER_TAGS = Object.freeze([
  ATTRIBUTION_FIELDS.scmProvider,
  ATTRIBUTION_FIELDS.repository,
  ATTRIBUTION_FIELDS.branch,
]);

/** Env var Codex's `env_http_headers` reads the git branch from. */
export const CODEX_BRANCH_ENV = "KONG_AI_SCM_BRANCH";

const autoTags = (...names) => Object.freeze(names.map((tag) => Object.freeze({ tag, needsHintHeaders: false })));

/**
 * What Kong AI cost management reports per agent: tags the tool sends itself,
 * fields reported from headers you add, and fields sent as additional headers.
 */
export const ATTRIBUTION_AGENTS = Object.freeze({
  "claude-code": Object.freeze({
    id: "claude-code",
    name: "Claude Code",
    configKey: "claudeCode",
    command: "claude",
    autoSent: AUTO_SENT_TAGS,
    fields: Object.freeze(["scmProvider", "repository", "branch"]),
    additionalFields: Object.freeze(["project"]),
    hintHeaders: true,
    wrapperFile: "claude-attribution.sh",
  }),
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    configKey: "codex",
    command: "codex",
    autoSent: autoTags(
      "Agent session",
      "Agent request kind",
      "Repository",
      "Source control provider",
      "Commit",
      "Agent ID",
      "Parent agent",
      "Agent type",
    ),
    fields: Object.freeze(["branch", "project"]),
    additionalFields: Object.freeze([]),
    hintHeaders: false,
    wrapperFile: "codex-attribution.sh",
  }),
});

export const ATTRIBUTION_AGENT_IDS = Object.freeze(Object.keys(ATTRIBUTION_AGENTS));

/** Headers the gateway credential travels in; extra headers may not claim them. */
const RESERVED_HEADER_NAMES = new Set(["authorization", "apikey", "x-api-key"]);

const KNOWN_HEADER_NAMES = new Set(Object.values(ATTRIBUTION_HEADERS));

/** RFC 9110 token characters. */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class AttributionError extends Error {}

export function attributionAgent(agentId = "claude-code") {
  const agent = ATTRIBUTION_AGENTS[agentId];
  if (!agent) {
    throw new AttributionError(
      `Cost attribution is not available for "${agentId}". Use --agent ${ATTRIBUTION_AGENT_IDS.join(" or ")}.`,
    );
  }
  return agent;
}

export function attributionWrapperPath(home = homedir(), agentId = "claude-code") {
  return path.join(home, ".kong-ai-switch", attributionAgent(agentId).wrapperFile);
}

/** The line a user adds to ~/.zshrc; guarded so a missing file is harmless. */
export function attributionSourceLine(home = homedir(), agentId = "claude-code") {
  const file = attributionWrapperPath(home, agentId).replace(home, "$HOME");
  return `[ -f "${file}" ] && source "${file}"`;
}

export function validateHeaderName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new AttributionError("A header name is required.");
  if (!TOKEN_PATTERN.test(value)) {
    throw new AttributionError(
      `"${value}" is not a valid HTTP header name. Use letters, digits and ! # $ % & ' * + - . ^ _ \` | ~ only.`,
    );
  }
  return value;
}

/** Trim and reject anything that would split into a second header line. */
export function validateHeaderValue(value, label = "Header value") {
  const text = String(value ?? "");
  if (/[\r\n]/.test(text.trim())) {
    throw new AttributionError(`${label} must be a single line.`);
  }
  // Other control characters would corrupt the header block just the same.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new AttributionError(`${label} contains control characters.`);
  }
  return text.trim();
}

/** Lenient form for values read back from disk: strip rather than fail. */
function cleanValue(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
}

/** Parse `Name: value` into a validated header. */
export function parseHeaderLine(line) {
  const text = String(line ?? "");
  const colon = text.indexOf(":");
  if (colon <= 0) {
    throw new AttributionError(`"${text}" is not a header. Use the form "Name: value".`);
  }
  const name = validateHeaderName(text.slice(0, colon));
  const value = validateHeaderValue(text.slice(colon + 1), `Value of ${name}`);
  return { name, value };
}

function validateExtraHeader({ name, value }, agentId = "claude-code") {
  const safeName = validateHeaderName(name);
  const lower = safeName.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower)) {
    throw new AttributionError(
      `"${safeName}" carries the gateway credential and cannot be set as an attribution header.`,
    );
  }
  if (KNOWN_HEADER_NAMES.has(lower)) {
    const agent = attributionAgent(agentId);
    const field = Object.values(ATTRIBUTION_FIELDS).find((f) => f.header === lower);
    if (!agent.fields.includes(field.key) && !agent.additionalFields.includes(field.key)) {
      throw new AttributionError(
        `"${safeName}" is not needed: ${agent.name} sends the ${field.tag.toLowerCase()} itself.`,
      );
    }
    const flags = [...agent.fields, ...agent.additionalFields]
      .map((key) => `--${key === "scmProvider" ? "scm-provider" : key}`)
      .sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b));
    const list = flags.length > 1 ? `${flags.slice(0, -1).join(", ")} or ${flags.at(-1)}` : flags[0];
    throw new AttributionError(`"${safeName}" has its own setting; use ${list}.`);
  }
  return { name: safeName, value: validateHeaderValue(value, `Value of ${safeName}`) };
}

const FLAG_ORDER = ["--project", "--scm-provider", "--repository", "--branch"];

export const EMPTY_ATTRIBUTION = Object.freeze({
  enabled: false,
  hintHeaders: true,
  project: "",
  scmProvider: "",
  repository: "",
  repositoryAuto: false,
  branch: "",
  branchAuto: false,
  headers: [],
});

/**
 * Canonical attribution record. Throws AttributionError on invalid input so a
 * bad value is refused when it is set, not discovered at the gateway.
 */
export function normalizeAttribution(input = {}, agentId = "claude-code") {
  const agent = attributionAgent(agentId);
  const src = input && typeof input === "object" ? input : {};
  const out = emptyAttribution(agentId);

  out.enabled = Boolean(src.enabled);
  out.hintHeaders = agent.hintHeaders && (src.hintHeaders === undefined ? true : Boolean(src.hintHeaders));
  out.project = validateHeaderValue(src.project ?? "", "Project");
  out.scmProvider = validateHeaderValue(src.scmProvider ?? "", "SCM provider").toLowerCase();
  out.repositoryAuto = Boolean(src.repositoryAuto);
  out.repository = out.repositoryAuto ? "" : validateHeaderValue(src.repository ?? "", "Repository");
  out.branchAuto = Boolean(src.branchAuto);
  out.branch = out.branchAuto ? "" : validateHeaderValue(src.branch ?? "", "Branch");

  const seen = new Map();
  for (const header of Array.isArray(src.headers) ? src.headers : []) {
    const clean = validateExtraHeader(header ?? {}, agentId);
    seen.set(clean.name.toLowerCase(), clean);
  }
  out.headers = [...seen.values()];

  // Fields the agent reports on its own are never sent as headers.
  const owned = new Set([...agent.fields, ...agent.additionalFields]);
  if (!owned.has("scmProvider")) out.scmProvider = "";
  if (!owned.has("repository")) {
    out.repository = "";
    out.repositoryAuto = false;
  }
  return out;
}

function emptyAttribution(agentId = "claude-code") {
  return { ...EMPTY_ATTRIBUTION, hintHeaders: attributionAgent(agentId).hintHeaders, headers: [] };
}

/** Read one agent's stored record without throwing; used on every switch. */
export function readAttribution(stored, agentId = "claude-code") {
  if (isPerAgentShape(stored)) return readAgentAttribution(stored, agentId);
  if (!stored || typeof stored !== "object") return emptyAttribution(agentId);
  try {
    return normalizeAttribution(stored, agentId);
  } catch {
    const headers = (Array.isArray(stored.headers) ? stored.headers : [])
      .map((h) => ({ name: String(h?.name ?? "").trim(), value: cleanValue(h?.value) }))
      .filter((h) => {
        const lower = h.name.toLowerCase();
        return TOKEN_PATTERN.test(h.name) && !RESERVED_HEADER_NAMES.has(lower) && !KNOWN_HEADER_NAMES.has(lower);
      });
    try {
      return normalizeAttribution({
        ...stored,
        project: cleanValue(stored.project),
        scmProvider: cleanValue(stored.scmProvider),
        repository: cleanValue(stored.repository),
        branch: cleanValue(stored.branch),
        headers,
      }, agentId);
    } catch {
      return emptyAttribution(agentId);
    }
  }
}

// ---------------------------------------------------------------------------
// Stored shape: { claudeCode, codex } per environment. 0.2.7/0.2.8 stored one
// bare record, which was always Claude Code's.
// ---------------------------------------------------------------------------

function isPerAgentShape(stored) {
  return Boolean(
    stored &&
      typeof stored === "object" &&
      Object.values(ATTRIBUTION_AGENTS).some((a) => Object.hasOwn(stored, a.configKey)),
  );
}

/** One agent's raw record from an environment's stored attribution, or null. */
export function storedAgentAttribution(stored, agentId = "claude-code") {
  const agent = attributionAgent(agentId);
  if (!stored || typeof stored !== "object") return null;
  if (isPerAgentShape(stored)) return stored[agent.configKey] ?? null;
  return agent.id === "claude-code" ? stored : null;
}

export function readAgentAttribution(stored, agentId = "claude-code") {
  return readAttribution(storedAgentAttribution(stored, agentId), agentId);
}

/**
 * Replace (or with null, drop) one agent's record, migrating the legacy shape.
 * Returns null when no agent has a record left.
 */
export function putAgentAttribution(stored, agentId, record) {
  attributionAgent(agentId);
  const out = {};
  for (const agent of Object.values(ATTRIBUTION_AGENTS)) {
    const value = agent.id === agentId ? record : storedAgentAttribution(stored, agent.id);
    if (value) out[agent.configKey] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** Either stored shape, leniently cleaned into the per-agent shape (for import). */
export function normalizeStoredAttribution(stored) {
  let out = null;
  for (const id of ATTRIBUTION_AGENT_IDS) {
    const raw = storedAgentAttribution(stored, id);
    if (raw) out = putAgentAttribution(out, id, readAttribution(raw, id));
  }
  return out;
}

export function usesAutoGit(attribution) {
  return Boolean(attribution?.enabled && (attribution.repositoryAuto || attribution.branchAuto));
}

/** Static attribution headers in send order. Empty when disabled. */
export function staticAttributionHeaders(attribution) {
  if (!attribution?.enabled) return [];
  const headers = [];
  const push = (name, value) => {
    if (value) headers.push({ name, value });
  };
  push(ATTRIBUTION_HEADERS.project, attribution.project);
  push(ATTRIBUTION_HEADERS.scmProvider, attribution.scmProvider);
  if (!attribution.repositoryAuto) push(ATTRIBUTION_HEADERS.repository, attribution.repository);
  if (!attribution.branchAuto) push(ATTRIBUTION_HEADERS.branch, attribution.branch);
  for (const h of attribution.headers ?? []) push(h.name, h.value);
  return headers;
}

/** Every header name attribution could own, for removal on change or disable. */
export function managedHeaderNames(...records) {
  const names = new Set(KNOWN_HEADER_NAMES);
  for (const record of records) {
    for (const h of record?.headers ?? []) names.add(String(h.name).toLowerCase());
  }
  return names;
}

export function parseHeaderBlock(block) {
  if (typeof block !== "string" || !block.trim()) return [];
  return block
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) return null;
      return { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
    })
    .filter((h) => h && h.name);
}

export function formatHeaderBlock(headers) {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

/**
 * Merge attribution into an existing ANTHROPIC_CUSTOM_HEADERS block.
 *
 * Lines attribution does not own (the key-auth credential, chiefly) are kept
 * first and always win a name clash. `credentialHeader` is never treated as
 * an attribution header even if a stale record names it.
 */
export function mergeCustomHeaders(existingBlock, attribution, { credentialHeader, previous } = {}) {
  const managed = managedHeaderNames(attribution, previous);
  const credential = credentialHeader ? String(credentialHeader).toLowerCase() : null;
  if (credential) managed.delete(credential);

  const kept = parseHeaderBlock(existingBlock).filter((h) => !managed.has(h.name.toLowerCase()));
  const keptNames = new Set(kept.map((h) => h.name.toLowerCase()));
  const added = staticAttributionHeaders(attribution).filter(
    (h) => !keptNames.has(h.name.toLowerCase()),
  );
  return formatHeaderBlock([...kept, ...added]);
}

/**
 * Apply attribution to a Claude Code settings `env` object in place.
 * Removes both keys cleanly when attribution is off or empty.
 */
export function applyAttributionToEnv(env, attribution, options = {}) {
  const block = mergeCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS, attribution, options);
  if (block) env.ANTHROPIC_CUSTOM_HEADERS = block;
  else delete env.ANTHROPIC_CUSTOM_HEADERS;

  if (attribution?.enabled && attribution.hintHeaders) env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = "1";
  else delete env.CLAUDE_CODE_GATEWAY_HINT_HEADERS;
  return env;
}

/**
 * Normalise a git remote URL to the repository path, e.g. `acme/payments-api`.
 *
 * Handles https, ssh://, scp-style `git@host:owner/repo`, GitLab subgroups and
 * Azure DevOps (`org/project/_git/repo` and `v3/org/project/repo`). The shell
 * wrapper implements the same steps; keep the two in sync.
 */
export function normalizeRepoUrl(url) {
  let value = String(url ?? "").trim();
  if (!value) return "";
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  if (value.includes("://")) {
    value = value.slice(value.indexOf("://") + 3);
    const at = value.indexOf("@");
    const slash = value.indexOf("/");
    if (at !== -1 && (slash === -1 || at < slash)) value = value.slice(at + 1);
    value = value.includes("/") ? value.slice(value.indexOf("/") + 1) : "";
  } else if (value.includes(":")) {
    value = value.slice(value.indexOf(":") + 1);
  }
  value = value.replace(/^v3\//, "").replace("/_git/", "/");
  return value.replace(/^\/+/, "");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** JSON string body (no surrounding quotes). */
function jsonInner(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

const WRAPPER_BEGIN = "# >>> kong-ai-switch (managed) >>>";
const WRAPPER_END = "# <<< kong-ai-switch (managed) <<<";

/** Placeholder written when no wrapper is needed, so a `source` line stays valid. */
export function buildInactiveWrapper(agentId = "claude-code") {
  const agent = attributionAgent(agentId);
  const file = agent.id === "codex" ? "~/.codex/config.toml" : "~/.claude/settings.json";
  const fn = agent.command;
  return [
    WRAPPER_BEGIN,
    `# ${agent.name} cost attribution: no git-derived headers are configured,`,
    `# so ${file} carries everything and no wrapper is needed.`,
    `if typeset -f ${fn} >/dev/null 2>&1 && typeset -f ${fn} | grep -q _kong_ai_switch_attr; then`,
    `  unset -f ${fn}`,
    "fi",
    WRAPPER_END,
    "",
  ].join("\n");
}

/**
 * Sourceable bash/zsh file defining a `codex()` wrapper that exports the git
 * branch for that launch only. config.toml maps it to the header through
 * `env_http_headers`, which Codex reads "when present": outside a git repo
 * the variable stays unset and the header is simply omitted.
 */
export function buildCodexAttributionWrapper(attribution, { environment, home = homedir() } = {}) {
  const lines = [
    WRAPPER_BEGIN,
    "# Codex cost attribution, generated by kong-ai-switch. Do not edit;",
    "# it is rewritten on every `kong-ai-switch use --agent codex`.",
  ];
  if (environment) lines.push(`# Environment: ${environment}`);
  lines.push(
    "#",
    "# Add to ~/.zshrc or ~/.bashrc:",
    `#   ${attributionSourceLine(home, "codex")}`,
    "#",
    `# ~/.codex/config.toml sends ${CODEX_BRANCH_ENV} as ${ATTRIBUTION_HEADERS.branch} (env_http_headers).`,
    "",
    "_kong_ai_switch_codex_branch() {",
    "  command git branch --show-current 2>/dev/null | tr -d '\\r\\n'",
    "}",
    "",
    "codex() {",
    "  local _kong_ai_switch_attr=1 _kas_v",
  );
  if (attribution.enabled && attribution.branchAuto) {
    lines.push(
      "  _kas_v=$(_kong_ai_switch_codex_branch)",
      "  if [ -n \"$_kas_v\" ]; then",
      `    ${CODEX_BRANCH_ENV}="$_kas_v" command codex "$@"`,
      "    return",
      "  fi",
    );
  }
  lines.push("  command codex \"$@\"", "}", WRAPPER_END, "");
  return lines.join("\n");
}

/**
 * Sourceable bash/zsh file defining a `claude()` wrapper that computes the
 * git-derived headers at launch.
 *
 * `staticBlock` is the final ANTHROPIC_CUSTOM_HEADERS written to settings.json
 * (credential plus static attribution) so both launch paths send the same
 * credential. Values are passed twice: as the env var the docs describe, and
 * via `--settings`, because settings.json `env` overrides the inherited
 * environment and would otherwise mask the git-derived headers.
 */
export function buildAttributionWrapper(
  attribution,
  { staticBlock = "", environment, home = homedir() } = {},
) {
  const lines = [
    WRAPPER_BEGIN,
    "# Claude Code cost attribution, generated by kong-ai-switch. Do not edit;",
    "# it is rewritten on every `kong-ai-switch use --agent claude-code`.",
  ];
  if (environment) lines.push(`# Environment: ${environment}`);
  lines.push(
    "#",
    "# Add to ~/.zshrc or ~/.bashrc:",
    `#   ${attributionSourceLine(home)}`,
    "",
    "_kong_ai_switch_git_repo() {",
    "  local url",
    "  url=$(command git remote get-url origin 2>/dev/null) || return 0",
    "  url=${url%/}",
    "  url=${url%.git}",
    "  case \"$url\" in",
    "    *://*)",
    "      url=${url#*://}",
    "      case \"${url%%/*}\" in *@*) url=${url#*@} ;; esac",
    "      case \"$url\" in */*) url=${url#*/} ;; *) url= ;; esac",
    "      ;;",
    "    *:*) url=${url#*:} ;;",
    "  esac",
    "  url=${url#v3/}",
    "  case \"$url\" in */_git/*) url=\"${url%%/_git/*}/${url#*/_git/}\" ;; esac",
    "  url=${url#/}",
    "  printf '%s' \"$url\" | tr -d '\"\\\\\\r\\n'",
    "}",
    "",
    "_kong_ai_switch_git_branch() {",
    "  command git branch --show-current 2>/dev/null | tr -d '\"\\\\\\r\\n'",
    "}",
    "",
    "claude() {",
    "  local _kong_ai_switch_attr=1 _kas_nl _kas_h _kas_j _kas_v",
    "  _kas_nl='",
    "'",
    `  _kas_h=${shellQuote(staticBlock)}`,
    `  _kas_j=${shellQuote(jsonInner(staticBlock))}`,
  );

  const dynamic = [];
  if (attribution.repositoryAuto) dynamic.push([ATTRIBUTION_HEADERS.repository, "_kong_ai_switch_git_repo"]);
  if (attribution.branchAuto) dynamic.push([ATTRIBUTION_HEADERS.branch, "_kong_ai_switch_git_branch"]);
  for (const [header, fn] of dynamic) {
    lines.push(
      `  _kas_v=$(${fn})`,
      "  if [ -n \"$_kas_v\" ]; then",
      "    if [ -n \"$_kas_h\" ]; then",
      `      _kas_h="\${_kas_h}\${_kas_nl}${header}: \${_kas_v}"`,
      `      _kas_j="\${_kas_j}\\\\n${header}: \${_kas_v}"`,
      "    else",
      `      _kas_h="${header}: \${_kas_v}"`,
      `      _kas_j="${header}: \${_kas_v}"`,
      "    fi",
      "  fi",
    );
  }

  lines.push(
    "  if [ -z \"$_kas_h\" ]; then",
    "    command claude \"$@\"",
    "    return",
    "  fi",
    "  ANTHROPIC_CUSTOM_HEADERS=\"$_kas_h\" command claude \\",
    "    --settings \"{\\\"env\\\":{\\\"ANTHROPIC_CUSTOM_HEADERS\\\":\\\"$_kas_j\\\"}}\" \"$@\"",
    "}",
    WRAPPER_END,
    "",
  );
  return lines.join("\n");
}

/**
 * Attribution grouped the way Kong reports it: tags Claude Code sends itself,
 * tags from the headers you add, and additional headers beyond those.
 */
function describeTags(attribution, hintHeaders, dynamic, agent) {
  const enabled = Boolean(attribution.enabled);
  const autoSent = agent.autoSent.map((t) => ({
    tag: t.tag,
    needsHintHeaders: t.needsHintHeaders,
    sent: t.needsHintHeaders ? hintHeaders : true,
  }));
  const fromHeaders = agent.fields.map((key) => {
    const t = ATTRIBUTION_FIELDS[key];
    const git = dynamic.find((d) => d.name === t.header);
    const value = enabled && !git ? attribution[t.key] || null : null;
    return {
      tag: t.tag,
      header: t.header,
      value,
      source: git ? `git: ${git.source}` : value ? "fixed" : null,
    };
  });
  const additional = [];
  for (const key of agent.additionalFields) {
    const t = ATTRIBUTION_FIELDS[key];
    if (enabled && attribution[t.key]) {
      additional.push({ label: t.tag, header: t.header, value: attribution[t.key] });
    }
  }
  if (enabled) {
    for (const h of attribution.headers ?? []) {
      if (h.value) additional.push({ label: null, header: h.name, value: h.value });
    }
  }
  return { autoSent, fromHeaders, additional };
}

/** Everything the CLI and app show about one environment's attribution. */
export function describeAttribution(attribution, { home = homedir(), agent: agentId = "claude-code" } = {}) {
  const agent = attributionAgent(agentId);
  const headers = staticAttributionHeaders(attribution);
  const dynamic = [];
  if (attribution.enabled && attribution.repositoryAuto) {
    dynamic.push({ name: ATTRIBUTION_HEADERS.repository, source: "git remote get-url origin" });
  }
  if (attribution.enabled && attribution.branchAuto) {
    dynamic.push({
      name: ATTRIBUTION_HEADERS.branch,
      source: "git branch --show-current",
      ...(agent.id === "codex" ? { env: CODEX_BRANCH_ENV } : {}),
    });
  }
  const preview = [
    ...headers.map((h) => `${h.name}: ${h.value}`),
    ...dynamic.map((d) => `${d.name}: $(${d.source})`),
  ].join("\n");
  const needsWrapper = usesAutoGit(attribution);
  const hintHeaders = Boolean(agent.hintHeaders && attribution.enabled && attribution.hintHeaders);
  return {
    agent: agent.id,
    attribution,
    headers,
    dynamicHeaders: dynamic,
    preview,
    hintHeaders,
    tags: describeTags(attribution, hintHeaders, dynamic, agent),
    needsWrapper,
    wrapperFile: attributionWrapperPath(home, agent.id),
    sourceLine: needsWrapper ? attributionSourceLine(home, agent.id) : null,
  };
}
