import Foundation

/// Runs the `kong-ai-switch` CLI and decodes its `--json` output.
///
/// A menu bar app launched from Finder does not inherit the shell's PATH, so
/// a plain `Process` with "kong-ai-switch" would fail for most users even
/// though the command works in their terminal. Locating the CLI is therefore
/// the bridge's main job, and the reason it is worth testing on its own.
public protocol CommandRunner: Sendable {
    /// Run a command, returning its exit status and captured output.
    func run(executable: URL, arguments: [String], environment: [String: String]) throws
        -> (status: Int32, stdout: Data, stderr: Data)
}

public struct ProcessRunner: CommandRunner {
    public init() {}

    public func run(executable: URL, arguments: [String], environment: [String: String]) throws
        -> (status: Int32, stdout: Data, stderr: Data)
    {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        try process.run()

        // Read before waiting: a full pipe buffer would otherwise deadlock
        // the child against a parent that is waiting for it to exit.
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        return (process.terminationStatus, stdout, stderr)
    }
}

public struct CLILocation: Sendable, Equatable {
    public let node: URL
    public let script: URL

    public init(node: URL, script: URL) {
        self.node = node
        self.script = script
    }
}

public enum CLIDiscovery {
    /// Directories to search for `node`, in order.
    ///
    /// A GUI app gets a minimal PATH, so the usual install locations are
    /// checked explicitly: Homebrew on Apple Silicon and Intel, the system
    /// path, and the common version managers.
    public static func nodeSearchPaths(home: String) -> [String] {
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(home)/.nvm/versions/node/current/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.asdf/shims/node",
            "\(home)/.local/bin/node",
        ]
    }

    /// Where the CLI's entry script might live relative to an install root.
    public static func scriptCandidates(appSupport: String, home: String) -> [String] {
        [
            "\(appSupport)/KongAISwitch/cli/src/cli/index.js",
            "\(home)/Documents/workplace/kong-ai-switch/src/cli/index.js",
            "/opt/homebrew/lib/node_modules/kong-ai-switch/src/cli/index.js",
            "/usr/local/lib/node_modules/kong-ai-switch/src/cli/index.js",
            "\(home)/.npm-global/lib/node_modules/kong-ai-switch/src/cli/index.js",
        ]
    }

    /// Find a usable node + CLI pair, or nil when either is missing.
    public static func locate(
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        scriptExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        home: String = NSHomeDirectory(),
        appSupport: String = NSSearchPathForDirectoriesInDomains(
            .applicationSupportDirectory, .userDomainMask, true
        ).first ?? "",
        overrideScript: String? = nil
    ) -> CLILocation? {
        guard let nodePath = nodeSearchPaths(home: home).first(where: fileExists) else { return nil }

        if let overrideScript, scriptExists(overrideScript) {
            return CLILocation(
                node: URL(fileURLWithPath: nodePath),
                script: URL(fileURLWithPath: overrideScript)
            )
        }

        guard
            let script = scriptCandidates(appSupport: appSupport, home: home)
                .first(where: scriptExists)
        else { return nil }

        return CLILocation(
            node: URL(fileURLWithPath: nodePath), script: URL(fileURLWithPath: script))
    }
}

public struct KongCLI: Sendable {
    let location: CLILocation
    let runner: any CommandRunner

    public init(location: CLILocation, runner: any CommandRunner = ProcessRunner()) {
        self.location = location
        self.runner = runner
    }

    /// Environment passed to the CLI.
    ///
    /// HOME must be forwarded or the CLI would look for config in the wrong
    /// place; PATH is set so `security` is reachable for keychain access.
    var childEnvironment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        return env
    }

    /// Run a subcommand and decode its JSON payload.
    public func run<T: Decodable>(_ arguments: [String], as type: T.Type) throws -> T {
        let result = try runner.run(
            executable: location.node,
            arguments: [location.script.path] + arguments + ["--json"],
            environment: childEnvironment
        )

        guard !result.stdout.isEmpty else {
            let stderr = String(data: result.stderr, encoding: .utf8) ?? ""
            throw CLIError(
                stderr.isEmpty
                    ? "kong-ai-switch produced no output (exit \(result.status))."
                    : stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        // A failing command still emits JSON, so prefer its message over the
        // decode error the caller would otherwise see.
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: result.stdout),
            envelope.ok == false
        {
            throw CLIError(envelope.error)
        }

        do {
            return try JSONDecoder().decode(type, from: result.stdout)
        } catch {
            let text = String(data: result.stdout, encoding: .utf8) ?? "(unreadable)"
            throw CLIError("Could not read the CLI's response: \(text.prefix(200))")
        }
    }

    public func listEnvironments() throws -> [KongEnvironment] {
        try run(["env", "list"], as: EnvironmentList.self).environments
    }

    public func listModels(environment: String?) throws -> ModelList {
        var args = ["list"]
        if let environment { args += ["--env", environment] }
        return try run(args, as: ModelList.self)
    }

    public func sync(environment: String?) throws -> SyncResult {
        var args = ["sync"]
        if let environment { args += ["--env", environment] }
        return try run(args, as: SyncResult.self)
    }

    public func use(model: String, environment: String?) throws -> SwitchResult {
        var args = ["use", model]
        if let environment { args += ["--env", environment] }
        return try run(args, as: SwitchResult.self)
    }

    public func status() throws -> StatusResult {
        try run(["status"], as: StatusResult.self)
    }

    /// Switch the active environment. This command has no JSON mode, so
    /// success is judged by exit status.
    public func useEnvironment(_ name: String) throws {
        let result = try runner.run(
            executable: location.node,
            arguments: [location.script.path, "env", "use", name],
            environment: childEnvironment
        )
        if result.status != 0 {
            let stderr = String(data: result.stderr, encoding: .utf8) ?? ""
            throw CLIError(
                stderr.isEmpty
                    ? "Could not switch to \"\(name)\"." : stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }
}
