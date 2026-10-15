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
    /// Agent id the top-level fields describe; absent from pre-0.2.9 CLIs (Claude Code).
    public let agent: String?
    public let attribution: AttributionSettings
    public let preview: String
    public let hintHeaders: Bool
    public let needsWrapper: Bool
    public let wrapperFile: String
    public let sourceLine: String?
    public let scmProviders: [String]?
    /// `set`/`clear` only: whether the agent's config was rewritten now.
    public let applied: Bool?
}

/// A tag Kong AI cost management reports that the agent sends itself.
public struct AutoSentTag: Hashable, Sendable {
    public let name: String
    /// Sent only with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`.
    public let needsHintHeaders: Bool
}

/// A reported tag that comes from a header you add.
public enum AttributionField: String, CaseIterable, Sendable {
    case scmProvider, repository, branch, project

    public var tag: String {
        switch self {
        case .scmProvider: "Source control provider"
        case .repository: "Repository"
        case .branch: "Branch"
        case .project: "Project"
        }
    }

    public var header: String {
        switch self {
        case .scmProvider: Attribution.scmProviderHeader
        case .repository: Attribution.repositoryHeader
        case .branch: Attribution.branchHeader
        case .project: Attribution.projectHeader
        }
    }
}

/// Agents with cost attribution. Mirrors `ATTRIBUTION_AGENTS` in `src/config/attribution.js`.
public enum AttributionAgent: String, CaseIterable, Sendable {
    case claudeCode = "claude-code"
    case codex

    public var name: String {
        switch self {
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        }
    }

    public var autoSentTags: [AutoSentTag] {
        switch self {
        case .claudeCode:
            [
                AutoSentTag(name: "Agent session", needsHintHeaders: false),
                AutoSentTag(name: "Agent ID", needsHintHeaders: false),
                AutoSentTag(name: "Parent agent", needsHintHeaders: false),
                AutoSentTag(name: "Agent request kind", needsHintHeaders: true),
                AutoSentTag(name: "Agent type", needsHintHeaders: true),
            ]
        case .codex:
            [
                "Agent session", "Agent request kind", "Repository", "Source control provider",
                "Commit", "Agent ID", "Parent agent", "Agent type",
            ].map { AutoSentTag(name: $0, needsHintHeaders: false) }
        }
    }

    /// Reported tags that come from headers you add, in display order.
    public var fields: [AttributionField] {
        switch self {
        case .claudeCode: [.scmProvider, .repository, .branch]
        case .codex: [.branch, .project]
        }
    }

    /// Fields sent as headers beyond the reported tags.
    public var additionalFields: [AttributionField] {
        switch self {
        case .claudeCode: [.project]
        case .codex: []
        }
    }

    public var supportsHintHeaders: Bool { self == .claudeCode }

    public var ownedFields: Set<AttributionField> { Set(fields + additionalFields) }

    /// Same guarded line the CLI prints; the wrapper path is fixed per agent.
    public var sourceLine: String {
        let file = "$HOME/.kong-ai-switch/\(self == .codex ? "codex" : "claude")-attribution.sh"
        return #"[ -f "\#(file)" ] && source "\#(file)""#
    }
}

public enum Attribution {
    /// Claude Code's auto-sent tags; see `AttributionAgent.autoSentTags`.
    public static let autoSentTags = AttributionAgent.claudeCode.autoSentTags

    public static let projectHeader = "ai-cost-project"
    public static let scmProviderHeader = "ai-cost-scm-provider"
    public static let repositoryHeader = "ai-cost-scm-repository"
    public static let branchHeader = "ai-cost-scm-branch"

    /// Env var Codex's `env_http_headers` maps to the branch header.
    public static let codexBranchEnv = "KONG_AI_SCM_BRANCH"

    public static let scmProviders = ["github", "gitlab", "bitbucket", "azure-devops", "other"]

    public static let sourceLine = AttributionAgent.claudeCode.sourceLine

    private static let reservedNames: Set<String> = ["authorization", "apikey", "x-api-key"]

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

    /// The record as the CLI will store it: fields the agent sends itself dropped.
    public static func forAgent(_ settings: AttributionSettings, _ agent: AttributionAgent) -> AttributionSettings {
        var out = settings
        let owned = agent.ownedFields
        if !owned.contains(.scmProvider) { out.scmProvider = "" }
        if !owned.contains(.repository) {
            out.repository = ""
            out.repositoryAuto = false
        }
        if !agent.supportsHintHeaders { out.hintHeaders = false }
        return out
    }

    /// First problem that would make the CLI refuse this record, or nil.
    public static func validationError(
        _ settings: AttributionSettings, agent: AttributionAgent = .claudeCode
    ) -> String? {
        let settings = forAgent(settings, agent)
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
            if let field = AttributionField.allCases.first(where: { $0.header == lower }) {
                return agent.ownedFields.contains(field)
                    ? "\"\(name)\" has its own field above."
                    : "\"\(name)\" is not needed: \(agent.name) sends the \(field.tag.lowercased()) itself."
            }
            if seen.contains(lower) { return "\"\(name)\" is listed twice." }
            seen.insert(lower)
            if !isSingleLine(header.value) { return "Value of \(name) must be a single line." }
        }
        return nil
    }

    /// Headers as the agent will send them; git-derived values shown as `$(…)`.
    public static func preview(_ settings: AttributionSettings, agent: AttributionAgent = .claudeCode) -> String {
        let settings = forAgent(settings, agent)
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

    /// Arguments for `attribution set`, replacing the agent's whole record.
    ///
    /// `--flag=value` keeps empty values and values starting with `--` intact.
    /// Codex refuses the Claude Code-only flags, so they are left out for it.
    public static func setArguments(
        environment: String?, settings: AttributionSettings, agent: AttributionAgent = .claudeCode
    ) -> [String] {
        var args = ["attribution", "set", "--agent", agent.rawValue]
        if let environment { args += ["--env", environment] }
        args.append("--enabled=\(settings.enabled)")
        if agent.supportsHintHeaders { args.append("--hint-headers=\(settings.hintHeaders)") }
        args.append("--project=\(trimmed(settings.project))")
        if agent.ownedFields.contains(.scmProvider) {
            args.append("--scm-provider=\(trimmed(settings.scmProvider))")
        }
        if agent.ownedFields.contains(.repository) {
            args.append("--repository=\(settings.repositoryAuto ? "auto" : trimmed(settings.repository))")
        }
        args += [
            "--branch=\(settings.branchAuto ? "auto" : trimmed(settings.branch))",
            "--clear-headers",
        ]
        for header in settings.headers where !trimmed(header.name).isEmpty {
            args.append("--header=\(trimmed(header.name)): \(trimmed(header.value))")
        }
        return args
    }
}
