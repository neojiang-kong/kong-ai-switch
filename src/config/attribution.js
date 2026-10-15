/**
 * AI cost-management attribution headers for Claude Code.
 *
 * Kong AI Gateway attributes spend by request headers (`ai-cost-project`,
 * `ai-cost-scm-*`, …). Claude Code sends extra headers from
 * ANTHROPIC_CUSTOM_HEADERS, one `Name: value` per line, and the request kind
 * and agent type when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1.
 *
 * Attribution is stored per environment in config.json, so each Konnect org
 * (or customer) can carry its own project. Static values go straight into
 * ~/.claude/settings.json. Repository and branch can instead be read from git
 * at launch, which settings.json cannot express (env values are not
 * evaluated), so those go into a sourceable shell wrapper.
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

/** Headers the gateway credential travels in; extra headers may not claim them. */
const RESERVED_HEADER_NAMES = new Set(["authorization", "apikey", "x-api-key"]);

const KNOWN_HEADER_NAMES = new Set(Object.values(ATTRIBUTION_HEADERS));

/** RFC 9110 token characters. */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class AttributionError extends Error {}

export function attributionWrapperPath(home = homedir()) {
  return path.join(home, ".kong-ai-switch", "claude-attribution.sh");
}

/** The line a user adds to ~/.zshrc; guarded so a missing file is harmless. */
export function attributionSourceLine(home = homedir()) {
  const file = attributionWrapperPath(home).replace(home, "$HOME");
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

function validateExtraHeader({ name, value }) {
  const safeName = validateHeaderName(name);
  const lower = safeName.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower)) {
    throw new AttributionError(
      `"${safeName}" carries the gateway credential and cannot be set as an attribution header.`,
    );
  }
  if (KNOWN_HEADER_NAMES.has(lower)) {
    throw new AttributionError(
      `"${safeName}" has its own setting; use --project, --scm-provider, --repository or --branch.`,
    );
  }
  return { name: safeName, value: validateHeaderValue(value, `Value of ${safeName}`) };
}

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
export function normalizeAttribution(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...EMPTY_ATTRIBUTION, headers: [] };

  out.enabled = Boolean(src.enabled);
  out.hintHeaders = src.hintHeaders === undefined ? true : Boolean(src.hintHeaders);
  out.project = validateHeaderValue(src.project ?? "", "Project");
  out.scmProvider = validateHeaderValue(src.scmProvider ?? "", "SCM provider").toLowerCase();
  out.repositoryAuto = Boolean(src.repositoryAuto);
  out.repository = out.repositoryAuto ? "" : validateHeaderValue(src.repository ?? "", "Repository");
  out.branchAuto = Boolean(src.branchAuto);
  out.branch = out.branchAuto ? "" : validateHeaderValue(src.branch ?? "", "Branch");

  const seen = new Map();
  for (const header of Array.isArray(src.headers) ? src.headers : []) {
    const clean = validateExtraHeader(header ?? {});
    seen.set(clean.name.toLowerCase(), clean);
  }
  out.headers = [...seen.values()];
  return out;
}

/** Read a stored record without throwing; used on every switch. */
export function readAttribution(stored) {
  if (!stored || typeof stored !== "object") return { ...EMPTY_ATTRIBUTION, headers: [] };
  try {
    return normalizeAttribution(stored);
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
      });
    } catch {
      return { ...EMPTY_ATTRIBUTION, headers: [] };
    }
  }
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
export function buildInactiveWrapper() {
  return [
    WRAPPER_BEGIN,
    "# Claude Code cost attribution: no git-derived headers are configured,",
    "# so ~/.claude/settings.json carries everything and no wrapper is needed.",
    "if typeset -f claude >/dev/null 2>&1 && typeset -f claude | grep -q _kong_ai_switch_attr; then",
    "  unset -f claude",
    "fi",
    WRAPPER_END,
    "",
  ].join("\n");
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

/** Everything the CLI and app show about one environment's attribution. */
export function describeAttribution(attribution, { home = homedir() } = {}) {
  const headers = staticAttributionHeaders(attribution);
  const dynamic = [];
  if (attribution.enabled && attribution.repositoryAuto) {
    dynamic.push({ name: ATTRIBUTION_HEADERS.repository, source: "git remote get-url origin" });
  }
  if (attribution.enabled && attribution.branchAuto) {
    dynamic.push({ name: ATTRIBUTION_HEADERS.branch, source: "git branch --show-current" });
  }
  const preview = [
    ...headers.map((h) => `${h.name}: ${h.value}`),
    ...dynamic.map((d) => `${d.name}: $(${d.source})`),
  ].join("\n");
  const needsWrapper = usesAutoGit(attribution);
  return {
    attribution,
    headers,
    dynamicHeaders: dynamic,
    preview,
    hintHeaders: Boolean(attribution.enabled && attribution.hintHeaders),
    needsWrapper,
    wrapperFile: attributionWrapperPath(home),
    sourceLine: needsWrapper ? attributionSourceLine(home) : null,
  };
}
