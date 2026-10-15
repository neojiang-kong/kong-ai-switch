import Foundation
import KongAISwitchCore

/// Self-checking test runner.
///
/// `swift test` needs XCTest, which ships inside Xcode.app. On a machine with
/// only the Command Line Tools it cannot build, so the checks live in a plain
/// executable instead: `swift run KongAISwitchChecks`. Same assertions, same
/// nonzero exit on failure, no Xcode required.

// `--which` reports the CLI the app would actually use, which is the fastest
// way to tell whether it resolved to a macOS-protected folder.
let arguments = CommandLine.arguments
if arguments.contains("--which") {
    if let location = CLIDiscovery.locate() {
        print("node:   \(location.node.path)")
        print("script: \(location.script.path)")
        let protectedRoots = ["/Documents/", "/Desktop/", "/Downloads/"]
        if protectedRoots.contains(where: { location.script.path.contains($0) }) {
            print("\nWARNING: that folder is protected by macOS; an unsigned app cannot read it.")
            print("Run build-app.sh to install a copy to Application Support.")
            exit(1)
        }
        print("\nReadable by the app.")
        exit(0)
    }
    print("No CLI found.")
    exit(1)
}

// `--live <script>` exercises the real CLI instead of stubs.
if let liveIndex = arguments.firstIndex(of: "--live"), liveIndex + 1 < arguments.count {
    exit(LiveCheck.run(scriptPath: arguments[liveIndex + 1]))
}

var failures = 0
var checks = 0

func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
        print("  ok   \(label)")
    } else {
        print("  FAIL \(label)")
        failures += 1
    }
}

func checkEqual<T: Equatable>(_ label: String, _ actual: T, _ expected: T) {
    checks += 1
    if actual == expected {
        print("  ok   \(label)")
    } else {
        print("  FAIL \(label)\n         expected: \(expected)\n         actual:   \(actual)")
        failures += 1
    }
}

func section(_ name: String) { print("\n\(name)") }

/// A runner that replays canned output, so decoding is tested without Konnect.
struct StubRunner: CommandRunner {
    let stdout: String
    let stderr: String
    let status: Int32

    init(stdout: String, stderr: String = "", status: Int32 = 0) {
        self.stdout = stdout
        self.stderr = stderr
        self.status = status
    }

    func run(executable: URL, arguments: [String], environment: [String: String]) throws
        -> (status: Int32, stdout: Data, stderr: Data)
    {
        (status, Data(stdout.utf8), Data(stderr.utf8))
    }
}

func makeCLI(_ runner: any CommandRunner) -> KongCLI {
    KongCLI(
        location: CLILocation(
            node: URL(fileURLWithPath: "/usr/bin/true"),
            script: URL(fileURLWithPath: "/tmp/cli.js")
        ),
        runner: runner
    )
}

// MARK: - CLI discovery

section("CLI discovery")

check(
    "finds node on Apple Silicon Homebrew",
    CLIDiscovery.locate(
        fileExists: { $0 == "/opt/homebrew/bin/node" },
        scriptExists: { $0.hasSuffix("index.js") },
        home: "/Users/test",
        appSupport: "/Users/test/Library/Application Support"
    )?.node.path == "/opt/homebrew/bin/node"
)

check(
    "falls back to Intel Homebrew when Apple Silicon path is absent",
    CLIDiscovery.locate(
        fileExists: { $0 == "/usr/local/bin/node" },
        scriptExists: { _ in true },
        home: "/Users/test",
        appSupport: ""
    )?.node.path == "/usr/local/bin/node"
)

check(
    "returns nil when node is missing entirely",
    CLIDiscovery.locate(
        fileExists: { _ in false },
        scriptExists: { _ in true },
        home: "/Users/test",
        appSupport: ""
    ) == nil
)

check(
    "returns nil when the CLI script is missing",
    CLIDiscovery.locate(
        fileExists: { _ in true },
        scriptExists: { _ in false },
        home: "/Users/test",
        appSupport: ""
    ) == nil
)

check(
    "an explicit script path overrides discovery",
    CLIDiscovery.locate(
        fileExists: { _ in true },
        scriptExists: { $0 == "/custom/cli.js" },
        home: "/Users/test",
        appSupport: "",
        overrideScript: "/custom/cli.js"
    )?.script.path == "/custom/cli.js"
)

check(
    "search paths cover both Homebrew prefixes",
    CLIDiscovery.nodeSearchPaths(home: "/Users/test").contains("/opt/homebrew/bin/node")
        && CLIDiscovery.nodeSearchPaths(home: "/Users/test").contains("/usr/local/bin/node")
)

// MARK: - Decoding

section("Decoding CLI output")

let envJSON = """
{
  "ok": true,
  "active": "mine",
  "environments": [
    {"name":"mine","region":"us","proxyUrl":"http://localhost:8000","gateway":null,
     "description":null,"active":true,"tokenSource":"keychain","hasToken":true,
     "modelCount":3,"syncedAt":"2026-09-22T00:00:00Z"},
    {"name":"acme","region":"eu","proxyUrl":null,"gateway":null,
     "description":"Acme POC","active":false,"tokenSource":"none","hasToken":false,
     "modelCount":0,"syncedAt":null}
  ]
}
"""

do {
    let envs = try makeCLI(StubRunner(stdout: envJSON)).listEnvironments()
    checkEqual("decodes two environments", envs.count, 2)
    checkEqual("marks the active one", envs.first(where: \.active)?.name, "mine")
    checkEqual("keychain source reads as Keychain", envs[0].tokenLabel, "Keychain")
    checkEqual("missing token reads as Not set", envs[1].tokenLabel, "Not set")
    checkEqual("a null proxy URL decodes as nil", envs[1].proxyUrl, nil)
} catch {
    check("environment decoding threw: \(error)", false)
}

let modelJSON = """
{
  "ok": true,
  "environment": "mine",
  "syncedAt": "2026-09-22T00:00:00Z",
  "profiles": [
    {"id":"g:my-claude","name":"my-claude","displayName":"Claude Opus","gatewayName":"AI Quickstart",
     "format":"anthropic","baseUrl":"http://localhost:8000","clientModelId":"my-claude",
     "targets":[{"model":"claude-opus-4-8","provider":"generic-anthropic"}],
     "requiresAuth":false,"claudeCode":{"ok":true,"reason":null},"active":true},
    {"id":"g:raw","name":"raw-openai","displayName":"Raw OpenAI","gatewayName":"AI Quickstart",
     "format":"openai","baseUrl":"http://localhost:8000/openai","clientModelId":"raw-openai",
     "targets":[{"model":"gpt-5","provider":"openai-prod"}],
     "requiresAuth":true,"claudeCode":{"ok":false,"reason":"serves the openai format"},"active":false}
  ]
}
"""

do {
    let list = try makeCLI(StubRunner(stdout: modelJSON)).listModels(environment: "mine")
    checkEqual("decodes two profiles", list.profiles.count, 2)
    checkEqual("anthropic model is usable", list.profiles[0].isUsable, true)
    checkEqual("openai model is not usable", list.profiles[1].isUsable, false)
    checkEqual("upstream summary reads well", list.profiles[0].upstreamSummary, "claude-opus-4-8")
    checkEqual("active flag survives", list.profiles[0].active, true)
    checkEqual("auth requirement survives", list.profiles[1].requiresAuth, true)
} catch {
    check("model decoding threw: \(error)", false)
}

do {
    let result = try makeCLI(
        StubRunner(
            stdout: """
            {"ok":true,"environment":"mine","gatewayCount":1,"modelCount":3,
             "skipped":[{"name":"embeddings","reason":"no generate capability"}]}
            """)
    ).sync(environment: "mine")
    checkEqual("sync reports model count", result.modelCount, 3)
    checkEqual("sync reports skipped entries", result.skipped.count, 1)
} catch {
    check("sync decoding threw: \(error)", false)
}

do {
    let status = try makeCLI(
        StubRunner(
            stdout: """
            {"ok":true,"configured":true,"settingsFile":"/Users/x/.claude/settings.json",
             "baseUrl":"http://localhost:8000","model":"my-claude","hasToken":true,
             "environment":"mine","gateway":"AI Quickstart"}
            """)
    ).status()
    checkEqual("status knows the environment", status.environment, "mine")
    checkEqual("status is configured", status.configured, true)
} catch {
    check("status decoding threw: \(error)", false)
}

// MARK: - Agents

section("Agents")

let agentJSON = """
{
  "ok": true,
  "agents": [
    {"id":"claude-code","name":"Claude Code","vendor":"anthropic","formats":["anthropic"],
     "file":"/Users/x/.claude/settings.json","configured":true,"model":"my-claude",
     "baseUrl":"http://localhost:8000","sharesConfigWith":null,"envFile":null},
    {"id":"claude-desktop","name":"Claude Desktop","vendor":"anthropic","formats":["anthropic"],
     "file":"/Users/x/.claude/settings.json","configured":true,"model":"my-claude",
     "baseUrl":"http://localhost:8000","sharesConfigWith":"claude-code","envFile":null},
    {"id":"codex","name":"Codex CLI","vendor":"openai","formats":["openai"],
     "file":"/Users/x/.codex/config.toml","configured":false,"model":null,
     "baseUrl":null,"sharesConfigWith":null,"envFile":null},
    {"id":"github-copilot","name":"GitHub Copilot","vendor":"github","formats":["openai","anthropic"],
     "file":"/Users/x/.copilot/settings.json","configured":false,"model":null,
     "baseUrl":null,"sharesConfigWith":null,"envFile":"/Users/x/.copilot/kong-ai-switch.env"}
  ]
}
"""

do {
    let agents = try makeCLI(StubRunner(stdout: agentJSON)).listAgents()
    checkEqual("decodes four agents", agents.count, 4)
    checkEqual("Claude Code speaks anthropic", agents[0].formats, ["anthropic"])
    checkEqual("Codex speaks openai", agents[2].formats, ["openai"])
    checkEqual("Copilot speaks openai and anthropic", agents[3].formats, ["openai", "anthropic"])
    checkEqual("a configured agent shows its model", agents[0].statusLabel, "my-claude")
    checkEqual("an unconfigured agent says so", agents[2].statusLabel, "not set")
    checkEqual("shared config is reported", agents[1].sharesConfigWith, "claude-code")
    checkEqual("a null model decodes as nil", agents[2].model, nil)
    checkEqual("vendor survives", agents[0].vendor, "anthropic")
    checkEqual("Copilot env file survives", agents[3].envFile, "/Users/x/.copilot/kong-ai-switch.env")
} catch {
    check("agent decoding threw: \(error)", false)
}

// MARK: - Error handling

section("Error handling")

do {
    _ = try makeCLI(
        StubRunner(stdout: #"{"ok":false,"error":"No environment named \"ghost\"."}"#, status: 1)
    ).listEnvironments()
    check("an error envelope should throw", false)
} catch let error as CLIError {
    check("surfaces the CLI's own message", error.message.contains("ghost"))
} catch {
    check("threw the wrong error type: \(error)", false)
}

do {
    _ = try makeCLI(StubRunner(stdout: "", stderr: "node: command failed", status: 127))
        .listEnvironments()
    check("empty output should throw", false)
} catch let error as CLIError {
    check("reports stderr when stdout is empty", error.message.contains("command failed"))
} catch {
    check("threw the wrong error type: \(error)", false)
}

do {
    _ = try makeCLI(StubRunner(stdout: "not json at all")).listEnvironments()
    check("unparseable output should throw", false)
} catch let error as CLIError {
    check("explains unreadable output", error.message.contains("Could not read"))
} catch {
    check("threw the wrong error type: \(error)", false)
}

// macOS blocks unsigned apps from ~/Documents. Node reports that as a raw
// EPERM stack trace, which must be translated into something actionable.
do {
    _ = try makeCLI(
        StubRunner(
            stdout: "",
            stderr: """
            node:fs:436
            Error: EPERM: operation not permitted, open '/Users/x/Documents/repo/src/cli/index.js'
                at Object.readFileSync (node:fs:436:20)
            """,
            status: 1
        )
    ).listEnvironments()
    check("an EPERM failure should throw", false)
} catch let error as CLIError {
    check("explains the macOS folder protection", error.message.contains("protected from unsigned apps"))
    check("points at the fix", error.message.contains("build-app.sh"))
    check("does not dump the stack trace", !error.message.contains("readFileSync"))
} catch {
    check("threw the wrong error type: \(error)", false)
}

// MARK: - Attribution

section("Cost attribution")

final class RecordingRunner: CommandRunner, @unchecked Sendable {
    let stdout: String
    var arguments: [String] = []
    init(stdout: String) { self.stdout = stdout }
    func run(executable: URL, arguments: [String], environment: [String: String]) throws
        -> (status: Int32, stdout: Data, stderr: Data)
    {
        self.arguments = arguments
        return (0, Data(stdout.utf8), Data())
    }
}

let attributionJSON = """
{"ok":true,"environment":"acme","scmProviders":["github","gitlab","bitbucket","azure-devops","other"],
 "attribution":{"enabled":true,"hintHeaders":true,"project":"payments-api","scmProvider":"github",
   "repository":"","repositoryAuto":true,"branch":"","branchAuto":true,
   "headers":[{"name":"ai-cost-team","value":"platform"}]},
 "headers":[{"name":"ai-cost-project","value":"payments-api"}],"dynamicHeaders":[],
 "preview":"ai-cost-project: payments-api","hintHeaders":true,"needsWrapper":true,
 "wrapperFile":"/Users/x/.kong-ai-switch/claude-attribution.sh",
 "sourceLine":"[ -f x ] && source x","applied":false}
"""

do {
    let runner = RecordingRunner(stdout: attributionJSON)
    let result = try makeCLI(runner).showAttribution(environment: "acme")
    checkEqual("attribution decodes the environment", result.environment, "acme")
    checkEqual("attribution decodes auto repository", result.attribution.repositoryAuto, true)
    checkEqual("attribution decodes extra headers", result.attribution.headers.map(\.name), ["ai-cost-team"])
    checkEqual("attribution reports the wrapper", result.needsWrapper, true)
    checkEqual(
        "show passes --agent and --env", Array(runner.arguments.dropFirst().prefix(6)),
        ["attribution", "show", "--agent", "claude-code", "--env", "acme"])
    checkEqual("pre-0.2.9 JSON decodes without an agent", result.agent, nil)
} catch {
    check("attribution decoding threw: \(error)", false)
}

do {
    let runner = RecordingRunner(stdout: attributionJSON.replacingOccurrences(
        of: #""ok":true,"#, with: #""ok":true,"agent":"codex","#))
    let result = try makeCLI(runner).showAttribution(environment: nil, agent: .codex)
    checkEqual("Codex attribution decodes its agent", result.agent, "codex")
    checkEqual(
        "Codex show passes --agent codex", Array(runner.arguments.dropFirst().prefix(4)),
        ["attribution", "show", "--agent", "codex"])
} catch {
    check("attribution decoding threw: \(error)", false)
}

let attributionSample = AttributionSettings(
    enabled: true, hintHeaders: false, project: " payments-api ", scmProvider: "github",
    repository: "", repositoryAuto: true, branch: "main", branchAuto: false,
    headers: [AttributionHeader(name: "x-cost-center", value: "--42"), AttributionHeader(name: " ", value: "")]
)
checkEqual(
    "set arguments replace the whole record with --flag=value",
    Attribution.setArguments(environment: "acme", settings: attributionSample),
    [
        "attribution", "set", "--agent", "claude-code", "--env", "acme", "--enabled=true",
        "--hint-headers=false", "--project=payments-api", "--scm-provider=github", "--repository=auto",
        "--branch=main", "--clear-headers", "--header=x-cost-center: --42",
    ]
)
checkEqual(
    "Codex set arguments leave out the flags Codex refuses",
    Attribution.setArguments(environment: "acme", settings: attributionSample, agent: .codex),
    [
        "attribution", "set", "--agent", "codex", "--env", "acme", "--enabled=true",
        "--project=payments-api", "--branch=main", "--clear-headers", "--header=x-cost-center: --42",
    ]
)
checkEqual(
    "Codex preview drops the fields Codex sends itself",
    Attribution.preview(attributionSample, agent: .codex),
    "ai-cost-project: payments-api\nai-cost-scm-branch: main\nx-cost-center: --42"
)
check(
    "Codex refuses a repository header it sends itself",
    Attribution.validationError(
        AttributionSettings(headers: [AttributionHeader(name: "ai-cost-scm-repository", value: "x")]),
        agent: .codex
    )?.contains("Codex sends the repository itself") == true
)
checkEqual(
    "Codex auto-sent tags match what Kong reports",
    AttributionAgent.codex.autoSentTags.map(\.name),
    [
        "Agent session", "Agent request kind", "Repository", "Source control provider", "Commit",
        "Agent ID", "Parent agent", "Agent type",
    ]
)
checkEqual("Codex fields are branch then project", AttributionAgent.codex.fields, [.branch, .project])
checkEqual(
    "Codex source line points at its own wrapper",
    AttributionAgent.codex.sourceLine,
    #"[ -f "$HOME/.kong-ai-switch/codex-attribution.sh" ] && source "$HOME/.kong-ai-switch/codex-attribution.sh""#
)
checkEqual("Claude source line is unchanged", Attribution.sourceLine, AttributionAgent.claudeCode.sourceLine)
checkEqual(
    "preview lists static then git-derived headers",
    Attribution.preview(attributionSample),
    "ai-cost-project: payments-api\nai-cost-scm-provider: github\nai-cost-scm-branch: main\n"
        + "x-cost-center: --42\nai-cost-scm-repository: $(git remote get-url origin)"
)
checkEqual("preview is empty when disabled", Attribution.preview(AttributionSettings(project: "p")), "")
check("valid record passes validation", Attribution.validationError(attributionSample) == nil)
check(
    "header names must be HTTP tokens",
    Attribution.validationError(AttributionSettings(headers: [AttributionHeader(name: "bad name", value: "x")])) != nil
)
check(
    "credential header names are refused",
    Attribution.validationError(AttributionSettings(headers: [AttributionHeader(name: "apikey", value: "x")]))?
        .contains("credential") == true
)
check(
    "multi-line values are refused",
    Attribution.validationError(AttributionSettings(project: "a\nb")) != nil
)
check("auto git is detected", attributionSample.usesAutoGit)
checkEqual(
    "auto-sent tags match what Kong reports",
    Attribution.autoSentTags.map(\.name),
    ["Agent session", "Agent ID", "Parent agent", "Agent request kind", "Agent type"]
)
checkEqual(
    "only request kind and agent type need hint headers",
    Attribution.autoSentTags.filter(\.needsHintHeaders).map(\.name),
    ["Agent request kind", "Agent type"]
)

// MARK: - Regions

section("Regions")

let clientSource = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../src/kong/client.js")
    .standardized
if let source = try? String(contentsOf: clientSource, encoding: .utf8) {
    let block = source.components(separatedBy: "export const KONNECT_REGIONS = {").last?
        .components(separatedBy: "};").first ?? ""
    let cliRegions = block.split(separator: "\n").compactMap { line -> String? in
        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: ":", maxSplits: 1)
        return parts.count == 2 ? String(parts[0]) : nil
    }
    checkEqual("Swift region list matches KONNECT_REGIONS", konnectRegions, cliRegions)
} else {
    print("  skip region sync check: \(clientSource.path) not readable")
}

// MARK: - Summary

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 {
    print("\(failures) FAILED")
    exit(1)
}
print("all checks passed")
