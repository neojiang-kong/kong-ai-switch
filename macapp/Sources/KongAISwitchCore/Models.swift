import Foundation

/// Types mirroring the CLI's `--json` envelope.
///
/// The app deliberately does not reimplement the Kong logic. It drives the
/// `kong-ai-switch` CLI, which is already covered by tests, and decodes these
/// shapes. That keeps one implementation of anything that touches Konnect or
/// the user's settings file.

public struct KongEnvironment: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let region: String
    public let proxyUrl: String?
    public let gateway: String?
    public let description: String?
    public let active: Bool
    public let tokenSource: String
    public let hasToken: Bool
    public let modelCount: Int
    public let syncedAt: String?

    public var id: String { name }

    /// How to describe where this environment's token lives, in the UI's words.
    public var tokenLabel: String {
        switch tokenSource {
        case "keychain": return "Keychain"
        case "file": return "Config file"
        case "KONNECT_TOKEN": return "Environment variable"
        default: return "Not set"
        }
    }

    public init(
        name: String, region: String, proxyUrl: String?, gateway: String?,
        description: String?, active: Bool, tokenSource: String, hasToken: Bool,
        modelCount: Int, syncedAt: String?
    ) {
        self.name = name
        self.region = region
        self.proxyUrl = proxyUrl
        self.gateway = gateway
        self.description = description
        self.active = active
        self.tokenSource = tokenSource
        self.hasToken = hasToken
        self.modelCount = modelCount
        self.syncedAt = syncedAt
    }
}

public struct EnvironmentList: Codable, Sendable {
    public let ok: Bool
    public let active: String?
    public let environments: [KongEnvironment]
}

public struct Target: Codable, Hashable, Sendable {
    public let model: String?
    public let provider: String?

    public init(model: String?, provider: String?) {
        self.model = model
        self.provider = provider
    }
}

public struct ClaudeCodeCompatibility: Codable, Hashable, Sendable {
    public let ok: Bool
    public let reason: String?

    public init(ok: Bool, reason: String?) {
        self.ok = ok
        self.reason = reason
    }
}

/// One AI Auth Strategy a model accepts.
public struct AuthStrategy: Codable, Hashable, Sendable {
    public let name: String?
    public let displayName: String?
    public let type: String?
    public let kind: String
    public let issuer: String?
    public let header: String?
    /// True for a long-lived key worth keeping in the Keychain. False for an
    /// OIDC bearer token, which expires and would fail mid-session if stored.
    public let storable: Bool
    public let hint: String?

    public var isKeyAuth: Bool { kind == "key-auth" }
    public var isOIDC: Bool { kind == "openid-connect" }
    public var label: String { displayName ?? name ?? kind }
}

/// How a client authenticates to a model.
public struct ModelAuth: Codable, Hashable, Sendable {
    public let required: Bool
    public let kind: String?
    public let strategies: [AuthStrategy]
    public let preferred: AuthStrategy?
    public let hasChoice: Bool?

    /// A credential this tool can store, so the UI can offer to remember it.
    public var acceptsStorableKey: Bool {
        strategies.contains { $0.storable }
    }

    public var keyAuth: AuthStrategy? { strategies.first { $0.isKeyAuth } }
    public var oidc: AuthStrategy? { strategies.first { $0.isOIDC } }
}

public struct ModelProfile: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let displayName: String
    public let gatewayName: String
    public let format: String
    public let baseUrl: String
    public let clientModelId: String
    public let targets: [Target]
    public let requiresAuth: Bool
    public let auth: ModelAuth?
    public let claudeCode: ClaudeCodeCompatibility?
    public let active: Bool?
    /// True when a storable key-auth credential exists in the Keychain.
    public let hasCredential: Bool?

    /// Upstream vendor models behind this virtual model, for display.
    public var upstreamSummary: String {
        let names = targets.compactMap(\.model)
        return names.isEmpty ? "—" : names.joined(separator: ", ")
    }

    /// Whether Claude Code can actually call this model.
    public var isUsable: Bool { claudeCode?.ok ?? true }
}

public struct ModelList: Codable, Sendable {
    public let ok: Bool
    public let environment: String
    public let syncedAt: String?
    public let totalCount: Int?
    public let hiddenCount: Int?
    public let profiles: [ModelProfile]
}

public struct SyncResult: Codable, Sendable {
    public struct Skipped: Codable, Sendable {
        public let name: String
        public let reason: String
    }
    public let ok: Bool
    public let environment: String
    public let gatewayCount: Int
    public let modelCount: Int
    public let skipped: [Skipped]
}

public struct SwitchResult: Codable, Sendable {
    public let ok: Bool
    public let environment: String
    public let model: String
    public let displayName: String
    public let baseUrl: String
    public let clientModelId: String
    public let gateway: String
    public let settingsFile: String
    public let created: Bool
}

public struct StatusResult: Codable, Sendable {
    public let ok: Bool
    public let configured: Bool
    public let settingsFile: String
    public let baseUrl: String?
    public let model: String?
    public let hasToken: Bool
    public let environment: String?
    public let gateway: String?
}

/// A coding agent that can be pointed at a Kong AI Gateway.
public struct Agent: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// Kong model formats this agent can call.
    public let formats: [String]
    public let file: String
    public let configured: Bool
    public let model: String?
    public let baseUrl: String?
    /// Set when this agent writes the same file as another one.
    public let sharesConfigWith: String?

    public var statusLabel: String {
        configured ? (model ?? "configured") : "not set"
    }
}

public struct AgentList: Codable, Sendable {
    public let ok: Bool
    public let agents: [Agent]
}

/// A gateway found by probing Konnect with only a token.
public struct DiscoveredGateway: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let displayName: String
    public let region: String
    public let deploymentType: String?
    /// Present only when an operator published it; data planes are
    /// self-managed, so Konnect often does not know the address.
    public let proxyUrl: String?
    public let needsProxyUrl: Bool
    public let modelCount: Int?

    /// A short suggestion for the environment name, derived from the gateway.
    public var suggestedEnvironmentName: String {
        let cleaned = name.lowercased().replacingOccurrences(
            of: "[^a-z0-9._-]", with: "-", options: .regularExpression)
        return cleaned.isEmpty ? "default" : cleaned
    }
}

public struct DiscoverResult: Codable, Sendable {
    public struct RegionError: Codable, Sendable {
        public let region: String
        public let error: String
    }
    public let ok: Bool
    public let gateways: [DiscoveredGateway]
    public let errors: [RegionError]
}

/// An error the CLI reported, carrying its message so the UI can show it.
public struct CLIError: Error, LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// The `{ ok: false, error: ... }` envelope shared by every failing command.
struct ErrorEnvelope: Codable {
    let ok: Bool
    let error: String
}
