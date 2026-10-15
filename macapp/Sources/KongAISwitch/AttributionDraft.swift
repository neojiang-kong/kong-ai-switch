import Foundation
import KongAISwitchCore

/// Editable copy of one environment's cost attribution for one agent.
///
/// Unlike `DesktopWriterPrefs` this is not kept in UserDefaults: the CLI owns
/// it (per environment and agent, in `~/.kong-ai-switch/config.json`) so a
/// plain `kong-ai-switch use` applies the same headers the app shows.
struct AttributionDraft: Equatable {
    /// Picker tag for a provider outside the known list.
    static let customProvider = "__custom__"

    var agent: AttributionAgent
    var settings: AttributionSettings
    /// "", a known provider, or `customProvider`.
    var scmChoice: String
    var scmCustom: String

    init(settings: AttributionSettings = .empty, agent: AttributionAgent = .claudeCode) {
        self.agent = agent
        self.settings = settings
        let provider = settings.scmProvider
        if provider.isEmpty || Attribution.scmProviders.contains(provider) {
            scmChoice = provider
            scmCustom = ""
        } else {
            scmChoice = Self.customProvider
            scmCustom = provider
        }
    }

    /// The record to save, with the provider picker folded in and blank rows dropped.
    var resolved: AttributionSettings {
        var out = settings
        out.scmProvider = scmChoice == Self.customProvider ? scmCustom : scmChoice
        out.headers = settings.headers.filter {
            !$0.name.trimmingCharacters(in: .whitespaces).isEmpty
                || !$0.value.trimmingCharacters(in: .whitespaces).isEmpty
        }
        return Attribution.forAgent(out, agent)
    }

    var preview: String { Attribution.preview(resolved, agent: agent) }

    var validationError: String? { Attribution.validationError(resolved, agent: agent) }
}
