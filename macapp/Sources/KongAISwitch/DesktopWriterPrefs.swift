import Foundation

/// How Claude Desktop's configLibrary profile should authenticate.
enum DesktopCredentialMode: String, CaseIterable, Identifiable {
    case staticJWT = "static"
    case interactive = "interactive"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .staticJWT: return "Static JWT"
        case .interactive: return "Interactive OIDC"
        }
    }
}

enum OIDCBearerTokenType: String, CaseIterable, Identifiable {
    case accessToken = "access_token"
    case idToken = "id_token"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .accessToken: return "access_token"
        case .idToken: return "id_token"
        }
    }
}

enum OIDCAuthFlow: String, CaseIterable, Identifiable {
    case browser = "browser"
    case broker = "broker"

    var id: String { rawValue }
}

/// Persisted Claude Desktop writer options (UserDefaults / app suite).
///
/// Keys live under the app bundle id (`com.konghq.kong-ai-switch`). Never mix
/// interactive OIDC with `inferenceGatewayApiKey` — the writer enforces that.
///
/// OIDC client ids are issuer-aware:
/// - `oidcClientIdEntra` — Microsoft Entra Application (client) ID (GUID)
/// - `oidcClientId` — optional override for non-Entra IdPs (e.g. Keycloak
///   `claude-desktop`); ignored when it looks like an Entra GUID
struct DesktopWriterPrefs: Equatable {
    var credentialMode: DesktopCredentialMode
    var modelDiscovery: Bool
    var trailingSlash: Bool
    var labelOverride: Bool
    /// Optional non-Entra OIDC client id override (Keycloak-style names).
    var oidcClientId: String
    /// Entra Application (client) ID — never applied to Keycloak issuers.
    var oidcClientIdEntra: String
    var oidcScopes: String
    var oidcRedirectPort: Int
    var oidcBearerTokenType: OIDCBearerTokenType
    var oidcAppendOfflineAccess: Bool
    var oidcAuthFlow: OIDCAuthFlow

    static let defaults = DesktopWriterPrefs(
        credentialMode: .staticJWT,
        modelDiscovery: false,
        trailingSlash: false,
        labelOverride: true,
        oidcClientId: "",
        oidcClientIdEntra: "",
        oidcScopes: "",
        oidcRedirectPort: 53180,
        oidcBearerTokenType: .accessToken,
        oidcAppendOfflineAccess: true,
        oidcAuthFlow: .browser
    )

    private enum Key {
        static let credentialMode = "desktopCredentialMode"
        static let modelDiscovery = "desktopModelDiscovery"
        static let trailingSlash = "desktopTrailingSlash"
        static let labelOverride = "desktopLabelOverride"
        static let oidcClientId = "oidcClientId"
        static let oidcClientIdEntra = "oidcClientIdEntra"
        static let oidcScopes = "oidcScopes"
        static let oidcRedirectPort = "oidcRedirectPort"
        static let oidcBearerTokenType = "oidcBearerTokenType"
        static let oidcAppendOfflineAccess = "oidcAppendOfflineAccess"
        static let oidcAuthFlow = "oidcAuthFlow"
    }

    /// True when the issuer URL is Microsoft Entra / AAD.
    static func isEntraIssuer(_ issuer: String) -> Bool {
        issuer.localizedCaseInsensitiveContains("login.microsoftonline.com")
            || issuer.localizedCaseInsensitiveContains("sts.windows.net")
    }

    /// Entra Application (client) IDs are UUIDs; Keycloak uses names like
    /// `claude-desktop`.
    static func looksLikeEntraClientId(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 36 else { return false }
        let pattern =
            #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
        return trimmed.range(of: pattern, options: .regularExpression) != nil
    }

    static func load(from defaults: UserDefaults = .standard) -> DesktopWriterPrefs {
        var prefs = DesktopWriterPrefs.defaults

        if let raw = defaults.string(forKey: Key.credentialMode),
            let mode = DesktopCredentialMode(rawValue: raw)
        {
            prefs.credentialMode = mode
        }
        if defaults.object(forKey: Key.modelDiscovery) != nil {
            prefs.modelDiscovery = defaults.bool(forKey: Key.modelDiscovery)
        }
        if defaults.object(forKey: Key.trailingSlash) != nil {
            prefs.trailingSlash = defaults.bool(forKey: Key.trailingSlash)
        }
        if defaults.object(forKey: Key.labelOverride) != nil {
            prefs.labelOverride = defaults.bool(forKey: Key.labelOverride)
        }

        let legacyClientId = defaults.string(forKey: Key.oidcClientId) ?? ""
        var entraClientId = defaults.string(forKey: Key.oidcClientIdEntra) ?? ""
        var genericClientId = legacyClientId

        // Migrate: a GUID previously stored under the global key was meant for
        // Entra only — move it so Keycloak keeps using agent defaults.
        if entraClientId.isEmpty, Self.looksLikeEntraClientId(legacyClientId) {
            entraClientId = legacyClientId.trimmingCharacters(in: .whitespacesAndNewlines)
            genericClientId = ""
            defaults.set(entraClientId, forKey: Key.oidcClientIdEntra)
            defaults.set("", forKey: Key.oidcClientId)
        }

        prefs.oidcClientId = genericClientId
        prefs.oidcClientIdEntra = entraClientId
        prefs.oidcScopes = defaults.string(forKey: Key.oidcScopes) ?? ""
        let port = defaults.integer(forKey: Key.oidcRedirectPort)
        if port > 0, port < 65536 {
            prefs.oidcRedirectPort = port
        }
        if let raw = defaults.string(forKey: Key.oidcBearerTokenType),
            let type = OIDCBearerTokenType(rawValue: raw)
        {
            prefs.oidcBearerTokenType = type
        }
        if defaults.object(forKey: Key.oidcAppendOfflineAccess) != nil {
            prefs.oidcAppendOfflineAccess = defaults.bool(forKey: Key.oidcAppendOfflineAccess)
        }
        if let raw = defaults.string(forKey: Key.oidcAuthFlow),
            let flow = OIDCAuthFlow(rawValue: raw)
        {
            prefs.oidcAuthFlow = flow
        }
        return prefs
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(credentialMode.rawValue, forKey: Key.credentialMode)
        defaults.set(modelDiscovery, forKey: Key.modelDiscovery)
        defaults.set(trailingSlash, forKey: Key.trailingSlash)
        defaults.set(labelOverride, forKey: Key.labelOverride)
        defaults.set(oidcClientId, forKey: Key.oidcClientId)
        defaults.set(oidcClientIdEntra, forKey: Key.oidcClientIdEntra)
        defaults.set(oidcScopes, forKey: Key.oidcScopes)
        defaults.set(oidcRedirectPort, forKey: Key.oidcRedirectPort)
        defaults.set(oidcBearerTokenType.rawValue, forKey: Key.oidcBearerTokenType)
        defaults.set(oidcAppendOfflineAccess, forKey: Key.oidcAppendOfflineAccess)
        defaults.set(oidcAuthFlow.rawValue, forKey: Key.oidcAuthFlow)
    }

    /// Issuer-aware client id override, or nil to fall through to agent defaults.
    ///
    /// - Entra: `oidcClientIdEntra`, or a GUID still sitting in `oidcClientId`.
    ///   Never invents `claude-desktop`.
    /// - Other IdPs: non-GUID `oidcClientId` only; Entra GUIDs are ignored.
    func resolvedOidcClientId(forIssuer issuer: String) -> String? {
        let generic = oidcClientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let entra = oidcClientIdEntra.trimmingCharacters(in: .whitespacesAndNewlines)

        if Self.isEntraIssuer(issuer) {
            if !entra.isEmpty { return entra }
            if Self.looksLikeEntraClientId(generic) { return generic }
            return nil
        }

        if !generic.isEmpty, !Self.looksLikeEntraClientId(generic) {
            return generic
        }
        return nil
    }
}
