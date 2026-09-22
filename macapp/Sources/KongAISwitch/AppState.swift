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
                // A never-synced environment has no catalogue; an empty list
                // is the correct result, not an error to show the user.
                let models = (try? cli.listModels(environment: active))?.profiles ?? []
                let status = try? cli.status()

                await MainActor.run {
                    self.environments = envs
                    self.models = models
                    self.status = status
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

    func clearToast() { toast = nil }
}
