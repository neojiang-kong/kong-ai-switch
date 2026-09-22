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
    @Published var formProxyUrl = "http://localhost:8000"
    @Published var formToken = ""
    @Published var formError: String?
    @Published var formSaving = false

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
        guard let model = status?.model, status?.configured == true else { return "Kong" }
        // Long Kong model names would crowd the bar; trim with an ellipsis.
        return model.count > 18 ? String(model.prefix(17)) + "…" : model
    }

    /// Models Claude Code can actually call.
    var usableModels: [ModelProfile] {
        models.filter(\.isUsable)
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
                    : ((try? cli.listModels(environment: active))?.profiles ?? [])
                let status = try? cli.status()

                await MainActor.run {
                    self.environments = envs
                    self.models = models
                    self.status = status
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
        perform("Switching") { cli in
            try cli.use(model: model.name, environment: name)
        } then: { result in
            self.toast = "Now using \(result.displayName). Restart Claude Code."
            self.refresh()
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
        formProxyUrl = editing?.proxyUrl ?? "http://localhost:8000"
        formToken = ""
        formError = nil
        formSaving = false
        showingSetup = true
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
