import Foundation
import KongAISwitchCore

/// End-to-end check against the real CLI.
///
/// The stub-based checks prove decoding; this proves the whole bridge — real
/// process launch, real JSON, real decode — which is the part that actually
/// breaks in a shipped app. Run it with `--live <path-to-cli-index.js>`.
enum LiveCheck {
    static func run(scriptPath: String) -> Int32 {
        print("Live check against \(scriptPath)\n")

        guard
            let location = CLIDiscovery.locate(
                overrideScript: scriptPath
            )
        else {
            print("  FAIL could not locate node or the CLI script")
            return 1
        }
        print("  node:   \(location.node.path)")
        print("  script: \(location.script.path)\n")

        let cli = KongCLI(location: location)
        var failures = 0

        func attempt(_ label: String, _ body: () throws -> String) {
            do {
                let detail = try body()
                print("  ok   \(label) — \(detail)")
            } catch {
                print("  FAIL \(label) — \(error.localizedDescription)")
                failures += 1
            }
        }

        attempt("env list") {
            let envs = try cli.listEnvironments()
            return "\(envs.count) environment(s): "
                + envs.map { "\($0.name)[\($0.tokenLabel)]" }.joined(separator: ", ")
        }

        attempt("list models") {
            // With no environments defined the CLI correctly refuses; that is
            // a valid state for a first run, not a failure of the bridge.
            guard let envs = try? cli.listEnvironments(), !envs.isEmpty else {
                return "skipped (no environments defined yet)"
            }
            let list = try cli.listModels(environment: nil)
            let usable = list.profiles.filter(\.isUsable).count
            return "\(list.profiles.count) model(s), \(usable) usable from Claude Code"
        }

        attempt("status") {
            let status = try cli.status()
            return status.configured
                ? "pointed at \(status.model ?? "none") via \(status.gateway ?? "unmatched gateway")"
                : "not configured"
        }

        // Exercise the create path the setup form uses. Only when asked, so
        // a plain live check never writes to the user's real config.
        if CommandLine.arguments.contains("--write") {
            let scratch = "livecheck-\(Int(Date().timeIntervalSince1970))"

            attempt("create environment") {
                try cli.saveEnvironment(
                    name: scratch,
                    region: ProcessInfo.processInfo.environment["LIVE_REGION"] ?? "us",
                    proxyUrl: "http://localhost:8000",
                    token: ProcessInfo.processInfo.environment["LIVE_TOKEN"],
                    isEditing: false
                )
                return "created \(scratch)"
            }

            attempt("environment appears in the list") {
                let envs = try cli.listEnvironments()
                guard envs.contains(where: { $0.name == scratch }) else {
                    throw CLIError("\(scratch) was not listed after creation")
                }
                return "found \(scratch)"
            }

            attempt("remove environment") {
                try cli.removeEnvironment(scratch)
                let envs = try cli.listEnvironments()
                guard !envs.contains(where: { $0.name == scratch }) else {
                    throw CLIError("\(scratch) still listed after removal")
                }
                return "removed \(scratch)"
            }
        }

        print("")
        if failures > 0 {
            print("\(failures) live check(s) FAILED")
            return 1
        }
        print("live checks passed")
        return 0
    }
}
