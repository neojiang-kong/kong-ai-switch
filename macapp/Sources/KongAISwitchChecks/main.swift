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
    {"id":"claude-code","name":"Claude Code","formats":["anthropic"],
     "file":"/Users/x/.claude/settings.json","configured":true,"model":"my-claude",
     "baseUrl":"http://localhost:8000","sharesConfigWith":null},
    {"id":"claude-desktop","name":"Claude Desktop","formats":["anthropic"],
     "file":"/Users/x/.claude/settings.json","configured":true,"model":"my-claude",
     "baseUrl":"http://localhost:8000","sharesConfigWith":"claude-code"},
    {"id":"codex","name":"Codex CLI","formats":["openai"],
     "file":"/Users/x/.codex/config.toml","configured":false,"model":null,
     "baseUrl":null,"sharesConfigWith":null}
  ]
}
"""

do {
    let agents = try makeCLI(StubRunner(stdout: agentJSON)).listAgents()
    checkEqual("decodes three agents", agents.count, 3)
    checkEqual("Claude Code speaks anthropic", agents[0].formats, ["anthropic"])
    checkEqual("Codex speaks openai", agents[2].formats, ["openai"])
    checkEqual("a configured agent shows its model", agents[0].statusLabel, "my-claude")
    checkEqual("an unconfigured agent says so", agents[2].statusLabel, "not set")
    checkEqual("shared config is reported", agents[1].sharesConfigWith, "claude-code")
    checkEqual("a null model decodes as nil", agents[2].model, nil)
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

// MARK: - Summary

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 {
    print("\(failures) FAILED")
    exit(1)
}
print("all checks passed")
