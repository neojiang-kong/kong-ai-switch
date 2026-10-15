import Foundation

/// AI cost-management attribution for Claude Code, stored per environment by
/// the CLI (`attribution show|set|clear`). Mirrors `src/config/attribution.js`.

public struct AttributionHeader: Codable, Identifiable, Hashable, Sendable {
    /// Row identity for editable lists; not part of the CLI's JSON.
    public var id = UUID()
    public var name: String
    public var value: String

    public init(name: String = "", value: String = "") {
        self.name = name
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case name, value }
}

public struct AttributionSettings: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var hintHeaders: Bool
    public var project: String
    public var scmProvider: String
    public var repository: String
    public var repositoryAuto: Bool
    public var branch: String
    public var branchAuto: Bool
    public var headers: [AttributionHeader]

    public init(
        enabled: Bool = false,
        hintHeaders: Bool = true,
        project: String = "",
        scmProvider: String = "",
        repository: String = "",
        repositoryAuto: Bool = false,
        branch: String = "",
        branchAuto: Bool = false,
        headers: [AttributionHeader] = []
    ) {
        self.enabled = enabled
        self.hintHeaders = hintHeaders
        self.project = project
        self.scmProvider = scmProvider
        self.repository = repository
        self.repositoryAuto = repositoryAuto
        self.branch = branch
        self.branchAuto = branchAuto
        self.headers = headers
    }

    public static let empty = AttributionSettings()

    public var usesAutoGit: Bool { enabled && (repositoryAuto || branchAuto) }
}

public struct AttributionResult: Codable, Sendable {
    public let ok: Bool
    public let environment: String
    public let attribution: AttributionSettings
    public let preview: String
    public let hintHeaders: Bool
    public let needsWrapper: Bool
    public let wrapperFile: String
    public let sourceLine: String?
    public let scmProviders: [String]?
    /// `set`/`clear` only: whether Claude Code's settings were rewritten now.
    public let applied: Bool?
}

public enum Attribution {
    public static let projectHeader = "ai-cost-project"
    public static let scmProviderHeader = "ai-cost-scm-provider"
    public static let repositoryHeader = "ai-cost-scm-repository"
    public static let branchHeader = "ai-cost-scm-branch"

    public static let scmProviders = ["github", "gitlab", "bitbucket", "azure-devops", "other"]

    /// Same guarded line the CLI prints; the wrapper path is fixed.
    public static let sourceLine =
        #"[ -f "$HOME/.kong-ai-switch/claude-attribution.sh" ] && source "$HOME/.kong-ai-switch/claude-attribution.sh""#

    private static let reservedNames: Set<String> = ["authorization", "apikey", "x-api-key"]
    private static let knownNames: Set<String> = [
        projectHeader, scmProviderHeader, repositoryHeader, branchHeader,
    ]

    private static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespaces)
    }

    /// RFC 9110 token characters.
    public static func isValidHeaderName(_ name: String) -> Bool {
        let allowed = CharacterSet(
            charactersIn: "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        let value = trimmed(name)
        return !value.isEmpty && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// Single line only; leading/trailing newlines are trimmed like the CLI does.
    public static func isSingleLine(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).contains(where: \.isNewline)
    }

    /// First problem that would make the CLI refuse this record, or nil.
    public static func validationError(_ settings: AttributionSettings) -> String? {
        let fields: [(String, String)] = [
            ("Project", settings.project),
            ("SCM provider", settings.scmProvider),
            ("Repository", settings.repositoryAuto ? "" : settings.repository),
            ("Branch", settings.branchAuto ? "" : settings.branch),
        ]
        for (label, value) in fields where !isSingleLine(value) {
            return "\(label) must be a single line."
        }
        var seen = Set<String>()
        for header in settings.headers {
            let name = trimmed(header.name)
            if name.isEmpty && trimmed(header.value).isEmpty { continue }
            guard isValidHeaderName(name) else {
                return "\"\(name)\" is not a valid header name (letters, digits and !#$%&'*+-.^_`|~)."
            }
            let lower = name.lowercased()
            if reservedNames.contains(lower) {
                return "\"\(name)\" carries the gateway credential and cannot be an attribution header."
            }
            if knownNames.contains(lower) {
                return "\"\(name)\" has its own field above."
            }
            if seen.contains(lower) { return "\"\(name)\" is listed twice." }
            seen.insert(lower)
            if !isSingleLine(header.value) { return "Value of \(name) must be a single line." }
        }
        return nil
    }

    /// Header block as Claude Code will send it; git-derived values shown as `$(…)`.
    public static func preview(_ settings: AttributionSettings) -> String {
        guard settings.enabled else { return "" }
        var lines: [String] = []
        func add(_ name: String, _ value: String) {
            let v = trimmed(value)
            if !v.isEmpty { lines.append("\(name): \(v)") }
        }
        add(projectHeader, settings.project)
        add(scmProviderHeader, settings.scmProvider)
        if !settings.repositoryAuto { add(repositoryHeader, settings.repository) }
        if !settings.branchAuto { add(branchHeader, settings.branch) }
        for header in settings.headers where !trimmed(header.name).isEmpty {
            add(trimmed(header.name), header.value)
        }
        if settings.repositoryAuto {
            lines.append("\(repositoryHeader): $(git remote get-url origin)")
        }
        if settings.branchAuto {
            lines.append("\(branchHeader): $(git branch --show-current)")
        }
        return lines.joined(separator: "\n")
    }

    /// Arguments for `attribution set`, replacing the whole record.
    ///
    /// `--flag=value` keeps empty values and values starting with `--` intact.
    public static func setArguments(environment: String?, settings: AttributionSettings) -> [String] {
        var args = ["attribution", "set"]
        if let environment { args += ["--env", environment] }
        args += [
            "--enabled=\(settings.enabled)",
            "--hint-headers=\(settings.hintHeaders)",
            "--project=\(trimmed(settings.project))",
            "--scm-provider=\(trimmed(settings.scmProvider))",
            "--repository=\(settings.repositoryAuto ? "auto" : trimmed(settings.repository))",
            "--branch=\(settings.branchAuto ? "auto" : trimmed(settings.branch))",
            "--clear-headers",
        ]
        for header in settings.headers where !trimmed(header.name).isEmpty {
            args.append("--header=\(trimmed(header.name)): \(trimmed(header.value))")
        }
        return args
    }
}
