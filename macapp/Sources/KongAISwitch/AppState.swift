import AppKit
import Foundation
import KongAISwitchCore
import SwiftUI

/// Observable state behind the menu bar UI.
///
/// Every CLI call is pushed off the main actor so the menu never blocks: a
/// sync against a slow Konnect region can take seconds, and a frozen menu bar
/// is the most visible way a small app can feel broken.
@MainActor
final class AppState: ObservableObject {
    @Published var environments: [KongEnvironment] = []
    @Published var models: [ModelProfile] = []
    @Published var gateways: [SyncedGateway] = []
    @Published var selectedGatewayId: String? = nil
    @Published var status: StatusResult?
    @Published var busy: String?
    @Published var errorMessage: String?
    @Published var toast: String?
    @Published var cliMissing = false
    /// Why discovery failed when `cliMissing` is true.
    @Published var cliMissingReason: CLIDiscovery.Failure?
    @Published var showingSetup = false
    @Published var editingEnvironment: KongEnvironment?

    // Setup form fields.
    //
    // These live here rather than as @State in the view: the SwiftUI macro
    // plugins that back @State ship with Xcode, and this project targets a
    // machine with only the Command Line Tools. @Published on an
    // ObservableObject needs no macro plugin and works the same way here.
    @Published var formName = ""
    @Published var formRegion = "us"
    @Published var formProxyUrl = ""
    @Published var formToken = ""
    @Published var formError: String?
    @Published var formSaving = false

    /// Setup is token-first: paste a token, let Konnect answer what exists,
    /// and only ask for what it could not tell us.
    enum SetupStep { case token, chooseGateway, confirm }
    @Published var setupStep: SetupStep = .token
    @Published var discovered: [DiscoveredGateway] = []
    @Published var discoveredOrganizationName: String?
    @Published var selectedGateway: DiscoveredGateway?
    @Published var discovering = false

    /// Coding agents, and which one the model list is filtered for.
    ///
    /// One gateway serves many clients, but they do not all speak the same
    /// protocol, so the model list is scoped to whichever agent is selected.
    @Published var agents: [Agent] = []
    @Published var selectedAgentId: String = "claude-code"

    /// Credential prompt, shown when a model's auth strategy needs one.
    @Published var credentialFor: ModelProfile?
    @Published var credentialValue = ""
    @Published var credentialUseKeyAuth = true
    @Published var credentialRemember = true
    @Published var credentialSaveOnly = false
    @Published var credentialError: String?
    @Published var oidcSigningIn = false

    /// In-flight browser OIDC login; cancelled when the credential sheet closes.
    private var oidcLoginTask: Task<Void, Never>?

    var selectedAgent: Agent? {
        agents.first { $0.id == selectedAgentId }
    }

    var selectedAgentName: String {
        selectedAgent?.name ?? "Claude Code"
    }

    private var cli: KongCLI?

    init() {
        locateCLI()
    }

    private func locateCLI() {
        switch CLIDiscovery.diagnose() {
        case .success(let location):
            cli = KongCLI(location: location)
            cliMissing = false
            cliMissingReason = nil
        case .failure(let reason):
            cli = nil
            cliMissing = true
            cliMissingReason = reason
        }
    }

    var activeEnvironmentName: String? {
        environments.first(where: \.active)?.name
    }

    /// Text shown next to the menu bar icon.
    ///
    /// Kept short: the menu bar is shared real estate. Showing the active
    /// model answers "what am I pointed at" without opening the panel, and
    /// makes the icon findable on a wide display where a bare glyph is not.
    var menuBarLabel: String {
        if cliMissing { return "Kong (setup)" }
        // Follow the selected agent so the bar matches what the panel shows.
        let model = selectedAgent?.configured == true ? selectedAgent?.model : status?.model
        guard let model, !model.isEmpty else { return "Kong" }
        // Long Kong model names would crowd the bar; trim with an ellipsis.
        return model.count > 18 ? String(model.prefix(17)) + "…" : model
    }

    /// Models on the selected gateway (or every gateway when none is chosen).
    var modelsForGateway: [ModelProfile] {
        guard let gatewayId = selectedGatewayId else { return models }
        return models.filter { $0.gatewayId == gatewayId }
    }

    /// Models the selected agent can call on the selected gateway.
    var usableModels: [ModelProfile] {
        let scoped = modelsForGateway
        guard let formats = selectedAgent?.formats, !formats.isEmpty else {
            return scoped
        }
        return scoped.filter { formats.contains($0.format) }
    }

    /// Models on this gateway that the selected agent cannot call.
    var hiddenModelCount: Int {
        max(0, modelsForGateway.count - usableModels.count)
    }

    var activeGateway: SyncedGateway? {
        gateways.first { $0.id == selectedGatewayId }
            ?? gatewaysWithModels.first { $0.id == selectedGatewayId }
    }

    /// Gateways that actually have models, for the picker.
    var gatewaysWithModels: [SyncedGateway] {
        let ids = Set(models.compactMap(\.gatewayId))
        let fromSync = gateways.filter { ids.contains($0.id) }
        if !fromSync.isEmpty { return fromSync }
        // Fall back when state has models but no gateway catalogue yet.
        return Dictionary(grouping: models, by: { $0.gatewayId ?? $0.gatewayName })
            .compactMap { key, profiles -> SyncedGateway? in
                guard let first = profiles.first else { return nil }
                return SyncedGateway(
                    id: first.gatewayId ?? key,
                    name: first.gatewayName,
                    displayName: first.gatewayName,
                    deploymentType: nil,
                    proxyUrl: nil
                )
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    /// Total synced models in the active environment (from the last list call).
    var totalModelCount: Int {
        activeEnvironment?.modelCount ?? models.count
    }

    var activeEnvironment: KongEnvironment? {
        environments.first(where: \.active)
    }

    /// Which auth kind the credential form is collecting.
    var selectedAuthKind: String {
        credentialUseKeyAuth ? "key-auth" : "openid-connect"
    }

    /// Run work off the main actor, surfacing any failure in the UI.
    private func perform<T>(
        _ label: String,
        _ work: @escaping @Sendable (KongCLI) throws -> T,
        then apply: @MainActor @escaping (T) -> Void
    ) {
        guard let cli else {
            cliMissing = true
            return
        }
        busy = label
        errorMessage = nil

        Task.detached(priority: .userInitiated) {
            do {
                let value = try work(cli)
                await MainActor.run {
                    apply(value)
                    self.busy = nil
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.busy = nil
                }
            }
        }
    }

    func refresh() {
        guard let cli else {
            cliMissing = true
            return
        }
        busy = "Loading"
        errorMessage = nil
        let agentId = selectedAgentId

        Task.detached(priority: .userInitiated) {
            do {
                let envs = try cli.listEnvironments()
                let active = envs.first(where: \.active)?.name

                let list = envs.isEmpty
                    ? nil
                    : try? cli.listModels(environment: active, agent: agentId)
                let models = list?.profiles ?? []
                let gateways = list?.gateways ?? []
                let status = try? cli.status()
                let agents = (try? cli.listAgents()) ?? []

                await MainActor.run {
                    self.environments = envs
                    self.models = models
                    self.gateways = gateways
                    // Keep the current gateway if it still exists; otherwise
                    // pick the one that owns the active model, or the first.
                    self.ensureGatewaySelection(models: models, gateways: gateways, status: status)
                    self.status = status
                    self.agents = agents
                    self.errorMessage = nil
                    self.busy = nil
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.busy = nil
                }
            }
        }
    }

    func sync() {
        let name = activeEnvironmentName
        // Do not force env.proxyUrl onto every gateway — each AI Gateway may
        // publish its own data plane. env.proxyUrl is only a sync fallback.
        perform("Syncing") { cli in
            try cli.sync(environment: name)
        } then: { result in
            if let name, let cli = self.cli {
                repointAgents(cli: cli, environment: name)
            }
            self.toast = "Synced \(result.modelCount) model\(result.modelCount == 1 ? "" : "s")."
            self.refresh()
        }
    }

    /// Whether this model still needs the user to type a credential in the UI.
    ///
    /// The whole point of the menu bar app is that the user never opens a
    /// terminal to paste a key. Open the form immediately when nothing is
    /// stored; only call the CLI once we have a value to hand it.
    func needsCredentialPrompt(_ model: ModelProfile) -> Bool {
        guard model.requiresAuth || model.auth?.required == true else { return false }
        // A saved key-auth credential is enough to switch without asking.
        if model.hasCredential == true { return false }
        return true
    }

    /// Switch to a model. Opens the in-app credential form when auth is needed
    /// and nothing is stored yet — never sends the user to the CLI.
    func use(
        model: ModelProfile,
        credential: String? = nil,
        remember: Bool = false,
        authKind: String? = nil,
        oidcClientId: String? = nil
    ) {
        // Ask in the UI first. Round-tripping to the CLI just to learn a key
        // is missing would put a red error on screen before the prompt.
        if credential == nil, needsCredentialPrompt(model) {
            beginCredential(for: model)
            return
        }

        let name = activeEnvironmentName
        let agentId = selectedAgentId
        let agentName = selectedAgentName
        let kind = authKind ?? (credential == nil ? nil : selectedAuthKind)
        // Prefer an explicit id (browser login), then UserDefaults, then azp from a pasted JWT.
        let clientId =
            oidcClientId
            ?? UserDefaults.standard.string(forKey: "oidcClientId").flatMap { $0.isEmpty ? nil : $0 }
            ?? Self.clientIdFromJwt(credential)

        guard let cli else {
            cliMissing = true
            return
        }
        busy = "Switching"
        errorMessage = nil

        Task.detached(priority: .userInitiated) {
            do {
                let result = try cli.use(
                    model: model.name, environment: name, agents: [agentId],
                    credential: credential, save: remember, authKind: kind,
                    oidcClientId: clientId
                )
                await MainActor.run {
                    self.busy = nil
                    self.credentialFor = nil
                    self.credentialValue = ""
                    self.credentialError = nil
                    self.credentialSaveOnly = false
                    self.toast = self.switchToast(
                        displayName: result.displayName, agentId: agentId, agentName: agentName)
                    self.refresh()
                }
            } catch {
                await MainActor.run {
                    self.busy = nil
                    let message = error.localizedDescription

                    // Still open the form if the CLI disagrees with our cache.
                    if message.contains("requires a credential"), model.auth?.required == true {
                        self.beginCredential(for: model)
                    } else if self.credentialFor != nil {
                        self.credentialError = message
                    } else {
                        self.errorMessage = message
                    }
                }
            }
        }
    }

    func beginCredential(for model: ModelProfile, saveOnly: Bool = false) {
        oidcLoginTask?.cancel()
        oidcLoginTask = nil
        oidcSigningIn = false
        credentialFor = model
        credentialValue = ""
        credentialError = nil
        credentialSaveOnly = saveOnly
        // Default to the strategy this tool can actually hold for the user.
        if let auth = model.auth {
            if auth.keyAuth != nil {
                credentialUseKeyAuth = true
            } else if auth.oidc != nil {
                credentialUseKeyAuth = false
            }
        }
        credentialRemember = true
    }

    func cancelCredential() {
        oidcLoginTask?.cancel()
        oidcLoginTask = nil
        oidcSigningIn = false
        credentialFor = nil
        credentialValue = ""
        credentialError = nil
        credentialSaveOnly = false
    }

    /// Public-client id for interactive OIDC (not the Kong gateway client).
    ///
    /// Claude Desktop registers `claude-desktop` with
    /// `http://127.0.0.1:53180/callback` — reuse that for Keycloak-style IdPs.
    /// Microsoft Entra needs a real Application (client) ID GUID; never invent
    /// `claude-desktop` for Entra. Override with UserDefaults `oidcClientId` /
    /// `oidcRedirectPort` when needed.
    func oidcLoginConfig(issuer: String) -> OIDCLoginConfig? {
        let defaults = UserDefaults.standard
        let isEntra =
            issuer.localizedCaseInsensitiveContains("login.microsoftonline.com")
            || issuer.localizedCaseInsensitiveContains("sts.windows.net")
        let stored = defaults.string(forKey: "oidcClientId").flatMap { $0.isEmpty ? nil : $0 }
        let clientId: String?
        if let stored {
            clientId = stored
        } else if isEntra {
            clientId = nil
        } else {
            switch selectedAgentId {
            case "claude-code", "claude-desktop": clientId = "claude-desktop"
            case "codex": clientId = "codex"
            default: clientId = "kong-ai-switch"
            }
        }
        guard let clientId else { return nil }
        let port: UInt16 = {
            let stored = defaults.integer(forKey: "oidcRedirectPort")
            if stored > 0, stored < 65536 { return UInt16(stored) }
            return 53180
        }()
        return OIDCLoginConfig(issuer: issuer, clientId: clientId, redirectPort: port)
    }

    /// Browser PKCE sign-in, then switch the model with the access token.
    func startOIDCBrowserLogin(for model: ModelProfile) {
        guard let issuer = model.auth?.oidc?.issuer, !issuer.isEmpty else {
            credentialError = "This model has no OIDC issuer configured."
            return
        }

        guard let config = oidcLoginConfig(issuer: issuer) else {
            credentialError =
                "Microsoft Entra needs your app's Application (client) ID. "
                + "Run: defaults write com.kong.KongAISwitch oidcClientId '<guid>'"
            return
        }

        oidcLoginTask?.cancel()
        credentialUseKeyAuth = false
        credentialError = nil
        oidcSigningIn = true
        busy = "Waiting for browser sign-in"

        let login = OIDCInteractiveLogin()

        oidcLoginTask = Task { [weak self] in
            do {
                let tokens = try await login.signIn(config: config) { url in
                    DispatchQueue.main.async {
                        NSWorkspace.shared.open(url)
                    }
                }
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self else { return }
                    self.oidcSigningIn = false
                    self.busy = nil
                    self.credentialValue = tokens.accessToken
                    self.credentialUseKeyAuth = false
                    // Apply immediately — same as Switch with a pasted token.
                    // Pass the PKCE client id so Claude Desktop gets the same one.
                    self.use(
                        model: model,
                        credential: tokens.accessToken,
                        remember: false,
                        authKind: "openid-connect",
                        oidcClientId: config.clientId
                    )
                }
            } catch is CancellationError {
                await MainActor.run {
                    self?.oidcSigningIn = false
                    self?.busy = nil
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.oidcSigningIn = false
                    self.busy = nil
                    if Task.isCancelled { return }
                    self.credentialError = error.localizedDescription
                }
            }
        }
    }

    func submitCredential(for model: ModelProfile) {
        let value = credentialValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            credentialError = "Enter the credential first."
            return
        }

        if credentialSaveOnly {
            // OIDC cannot be Keychain-saved; treat this as a one-shot switch.
            if credentialUseKeyAuth {
                saveCredentialOnly(for: model, value: value)
            } else {
                use(model: model, credential: value, remember: false, authKind: selectedAuthKind)
            }
            return
        }

        // An OIDC token is never stored, whatever the checkbox says.
        let remember = credentialUseKeyAuth && credentialRemember
        use(model: model, credential: value, remember: remember, authKind: selectedAuthKind)
    }

    /// Save an API key without switching, like ccswitch's manual key entry.
    func saveCredentialOnly(for model: ModelProfile, value: String? = nil) {
        let token = (value ?? credentialValue).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            credentialError = "Enter the API key first."
            return
        }
        guard credentialUseKeyAuth else {
            credentialError = "OIDC bearer tokens expire and are not stored. Switch with a fresh token instead."
            return
        }
        guard let cli else {
            cliMissing = true
            return
        }

        let name = activeEnvironmentName
        busy = "Saving"
        credentialError = nil

        Task.detached(priority: .userInitiated) {
            do {
                try cli.setCredential(model: model.name, environment: name, token: token)
                await MainActor.run {
                    self.busy = nil
                    self.credentialFor = nil
                    self.credentialValue = ""
                    self.credentialError = nil
                    self.credentialSaveOnly = false
                    self.toast = "Saved key for \(model.displayName)."
                    self.refresh()
                }
            } catch {
                await MainActor.run {
                    self.busy = nil
                    self.credentialError = error.localizedDescription
                }
            }
        }
    }

    func clearCredential(for model: ModelProfile) {
        let name = activeEnvironmentName
        perform("Clearing") { cli in
            try cli.clearCredential(model: model.name, environment: name)
        } then: { _ in
            self.toast = "Removed key for \(model.displayName)."
            self.refresh()
        }
    }

    /// Toast copy after a successful switch — Copilot needs a sourced env file.
    private func switchToast(displayName: String, agentId: String, agentName: String) -> String {
        if agentId == "github-copilot" {
            return "Now using \(displayName). In a terminal: source ~/.copilot/kong-ai-switch.env && copilot"
        }
        return "Now using \(displayName). Restart \(agentName)."
    }

    /// Whether a model row should show as selected for the current agent.
    ///
    /// Compare against that agent's own status (not Claude Code's `active`
    /// flag from `list`). Normalize trailing slashes so gateway URLs match.
    func isModelActive(_ model: ModelProfile) -> Bool {
        guard let agent = selectedAgent, agent.configured else {
            return model.active ?? false
        }
        let modelMatch =
            agent.model == model.clientModelId
            || agent.model == model.name
            || agent.model == model.displayName
        guard modelMatch else { return false }
        guard let rawBase = agent.baseUrl, !rawBase.isEmpty else { return true }
        return Self.sameGatewayURL(rawBase, model.baseUrl)
    }

    /// Kong / Codex configs often differ by a trailing slash only.
    private static func sameGatewayURL(_ a: String, _ b: String) -> Bool {
        let left = a.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let right = b.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return left == right || left.hasPrefix(right) || right.hasPrefix(left)
    }

    /// Change which agent the model list is scoped to.
    ///
    /// Re-lists so each model's `active` flag matches this agent.
    func selectAgent(_ id: String) {
        guard id != selectedAgentId else { return }
        selectedAgentId = id
        refresh()
    }

    /// Scope the model list to one AI Gateway control plane.
    func selectGateway(_ id: String?) {
        selectedGatewayId = id
    }

    /// Pick a sensible gateway after refresh without clobbering the user's choice.
    private func ensureGatewaySelection(
        models: [ModelProfile], gateways: [SyncedGateway], status: StatusResult?
    ) {
        let available = Set(models.compactMap(\.gatewayId))
        if let current = selectedGatewayId, available.contains(current) { return }

        // Prefer the gateway behind the model Claude Code is already using.
        if let statusModel = status?.model,
            let match = models.first(where: { $0.clientModelId == statusModel || $0.name == statusModel }),
            let gid = match.gatewayId
        {
            selectedGatewayId = gid
            return
        }

        // Else first gateway that has any model.
        if let first = gateways.first(where: { available.contains($0.id) })?.id
            ?? models.compactMap(\.gatewayId).first
        {
            selectedGatewayId = first
        } else {
            selectedGatewayId = nil
        }
    }

    func switchEnvironment(to name: String) {
        perform("Switching environment") { cli in
            try cli.useEnvironment(name)
        } then: { _ in
            self.refresh()
        }
    }

    func removeEnvironment(_ name: String) {
        perform("Removing") { cli in
            try cli.removeEnvironment(name)
        } then: { _ in
            self.toast = "Removed \"\(name)\"."
            self.refresh()
        }
    }

    func beginSetup(editing: KongEnvironment? = nil) {
        editingEnvironment = editing
        formName = editing?.name ?? ""
        formRegion = editing?.region ?? "us"
        formProxyUrl = editing?.proxyUrl ?? ""
        formToken = ""
        formError = nil
        formSaving = false
        discovered = []
        discoveredOrganizationName = nil
        selectedGateway = nil
        discovering = false
        // Editing skips discovery: the environment already exists and the
        // user is here to change one field.
        setupStep = editing == nil ? .token : .confirm
        showingSetup = true
    }

    /// Ask Konnect what this token can see.
    ///
    /// This is the step that makes the token do the work: it finds the
    /// gateways, their region, and their proxy URL when one is published,
    /// so the user is never asked for something Kong already knows.
    func discoverGateways() {
        let token = formToken.trimmingCharacters(in: .whitespaces)
        guard !token.isEmpty else {
            formError = "Paste your Konnect token first."
            return
        }
        guard let cli else {
            cliMissing = true
            return
        }

        discovering = true
        formError = nil

        Task.detached(priority: .userInitiated) {
            do {
                let result = try cli.discover(token: token, region: nil)
                await MainActor.run {
                    self.discovering = false
                    self.discovered = result.gateways
                    self.discoveredOrganizationName = result.organization?.name

                    if result.gateways.isEmpty {
                        self.formError =
                            "That token works, but no AI Gateways were found in any region."
                        return
                    }
                    // One gateway is the common case; skip the picker.
                    if result.gateways.count == 1 {
                        self.chooseGateway(result.gateways[0])
                    } else {
                        self.setupStep = .chooseGateway
                    }
                }
            } catch {
                await MainActor.run {
                    self.discovering = false
                    self.formError = error.localizedDescription
                }
            }
        }
    }

    /// Adopt a discovered gateway's details into the form.
    func chooseGateway(_ gateway: DiscoveredGateway) {
        selectedGateway = gateway
        formRegion = gateway.region
        formProxyUrl = gateway.proxyUrl ?? ""
        // Prefer the Konnect org name as the environment id — gateways already
        // have their own picker. Falling back to the gateway slug is legacy.
        if formName.isEmpty {
            if let suggested = slugify(discoveredOrganizationName), !suggested.isEmpty {
                formName = suggested
            } else {
                formName = gateway.suggestedEnvironmentName
            }
        }
        setupStep = .confirm
    }

    private func slugify(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        let cleaned = value.lowercased().replacingOccurrences(
            of: "[^a-z0-9._-]", with: "-", options: .regularExpression)
        let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? nil : String(trimmed.prefix(64))
    }

    func backToToken() {
        setupStep = .token
        formError = nil
    }

    func cancelSetup() {
        showingSetup = false
        editingEnvironment = nil
        formError = nil
    }

    /// Save the form, replacing the earlier completion-handler variant.
    func submitSetup() {
        let isEditing = editingEnvironment != nil
        let name = formName.trimmingCharacters(in: .whitespaces)
        let region = formRegion
        let proxyUrl = formProxyUrl.trimmingCharacters(in: .whitespaces)
        let token = formToken.isEmpty ? nil : formToken
        let organizationName = discoveredOrganizationName

        guard !name.isEmpty else {
            formError = "Give the environment a name."
            return
        }
        // Without a data plane address a switch would point Claude Code at
        // nothing, so refuse rather than write a broken environment.
        if proxyUrl.isEmpty {
            formError = "A data plane URL is needed, for example http://localhost:8000"
            return
        }
        guard let cli else {
            cliMissing = true
            return
        }

        formSaving = true
        formError = nil
        busy = isEditing ? "Saving" : "Creating"

        Task.detached(priority: .userInitiated) {
            do {
                try cli.saveEnvironment(
                    name: name, region: region, proxyUrl: proxyUrl,
                    token: token, organizationName: organizationName, isEditing: isEditing
                )
                // Sync without forcing --proxy-url so each gateway keeps its
                // own published data plane; env.proxyUrl is the fallback only.
                let synced = try? cli.sync(environment: name)
                repointAgents(cli: cli, environment: name)

                await MainActor.run {
                    self.formSaving = false
                    self.busy = nil
                    self.showingSetup = false
                    self.editingEnvironment = nil
                    if let synced {
                        self.toast =
                            "Saved. Synced \(synced.modelCount) model\(synced.modelCount == 1 ? "" : "s")."
                    } else {
                        self.toast = "Saved \"\(name)\"."
                    }
                    self.refresh()
                }
            } catch {
                await MainActor.run {
                    self.formSaving = false
                    self.busy = nil
                    self.formError = error.localizedDescription
                }
            }
        }
    }

    func clearToast() { toast = nil }

    /// Prefer `azp` / `appid` from a JWT payload (Entra public-client id).
    static func clientIdFromJwt(_ token: String?) -> String? {
        guard let token, !token.isEmpty else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = (4 - b64.count % 4) % 4
        if pad > 0 { b64 += String(repeating: "=", count: pad) }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        for key in ["azp", "appid", "client_id"] {
            if let value = json[key] as? String, !value.isEmpty { return value }
        }
        return nil
    }
}

/// Rewrite each configured agent's settings to the model's new base URL.
/// Kept off `AppState` so detached tasks can call it without MainActor.
private func repointAgents(cli: KongCLI, environment: String) {
    let agents = (try? cli.listAgents()) ?? []
    let models = (try? cli.listModels(environment: environment, agent: nil))?.profiles ?? []
    for agent in agents where agent.configured {
        guard let modelId = agent.model, !modelId.isEmpty else { continue }
        guard
            let profile = models.first(where: {
                $0.clientModelId == modelId || $0.name == modelId || $0.displayName == modelId
            })
        else { continue }
        // Re-use stored Keychain credentials; do not prompt.
        _ = try? cli.use(
            model: profile.name, environment: environment, agents: [agent.id],
            credential: nil, save: false, authKind: nil)
    }
}
