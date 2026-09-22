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
    @Published var status: StatusResult?
    @Published var busy: String?
    @Published var errorMessage: String?
    @Published var toast: String?
    @Published var cliMissing = false
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
    @Published var selectedGateway: DiscoveredGateway?
    @Published var discovering = false

    /// Coding agents, and which one the model list is filtered for.
    ///
    /// One gateway serves many clients, but they do not all speak the same
    /// protocol, so the model list is scoped to whichever agent is selected.
    @Published var agents: [Agent] = []
    @Published var selectedAgentId: String = "claude-code"

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
        guard let location = CLIDiscovery.locate() else {
            cliMissing = true
            return
        }
        cli = KongCLI(location: location)
        cliMissing = false
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

    /// Models the selected agent can actually call.
    ///
    /// The CLI already filters by agent, but an older cached response may
    /// carry models in other formats, so filter here too.
    var usableModels: [ModelProfile] {
        guard let formats = selectedAgent?.formats, !formats.isEmpty else {
            return models.filter(\.isUsable)
        }
        return models.filter { formats.contains($0.format) }
    }

    var hiddenModelCount: Int {
        models.count - usableModels.count
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

                // With no environments, or one never synced, the CLI has
                // nothing to list. That is a first-run state, not an error,
                // so it must not put a red message on the welcome screen.
                let models =
                    envs.isEmpty
                    ? []
                    : ((try? cli.listModels(environment: active, agent: agentId))?.profiles ?? [])
                let status = try? cli.status()
                let agents = (try? cli.listAgents()) ?? []

                await MainActor.run {
                    self.environments = envs
                    self.models = models
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
        perform("Syncing") { cli in
            try cli.sync(environment: name)
        } then: { result in
            self.toast = "Synced \(result.modelCount) model\(result.modelCount == 1 ? "" : "s")."
            self.refresh()
        }
    }

    func use(model: ModelProfile) {
        let name = activeEnvironmentName
        let agentId = selectedAgentId
        let agentName = selectedAgentName
        perform("Switching") { cli in
            try cli.use(model: model.name, environment: name, agents: [agentId])
        } then: { result in
            self.toast = "Now using \(result.displayName). Restart \(agentName)."
            self.refresh()
        }
    }

    /// Change which agent the model list is scoped to.
    func selectAgent(_ id: String) {
        guard id != selectedAgentId else { return }
        selectedAgentId = id
        refresh()
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
        if formName.isEmpty { formName = gateway.suggestedEnvironmentName }
        setupStep = .confirm
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
                    token: token, isEditing: isEditing
                )
                // A new environment is useless until synced, so do it here
                // rather than leaving the user an empty model list.
                let synced = try? cli.sync(environment: name)

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
}
