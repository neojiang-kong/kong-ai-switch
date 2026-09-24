import KongAISwitchCore
import SwiftUI

/// The menu bar panel.
///
/// Sized for a glance: which environment you are in, which model Claude Code
/// is pointed at, and a one-click switch to any other. Anything that needs
/// typing stays in the CLI.
struct MenuView: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.cliMissing {
                missingCLI
            } else if state.showingSetup {
                SetupView(state: state, editing: state.editingEnvironment)
            } else if state.showingDesktopSettings {
                DesktopSettingsView(state: state)
            } else if let profile = state.credentialFor {
                CredentialView(state: state, profile: profile)
            } else if state.environments.isEmpty {
                welcome
            } else {
                header
                Divider()
                // MenuBarExtra proposes a zero height to bare ScrollViews, so
                // maxHeight alone collapses the middle to nothing (header +
                // footer only). An explicit height keeps content visible and
                // scrollable when Environment/Gateway/Agents/Models stack up.
                ScrollView(.vertical, showsIndicators: true) {
                    content
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(width: 380, height: 440)
                Divider()
                footer
            }
        }
        .frame(width: 380)
        .onAppear { state.refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                BrandMark(kind: .kong, size: 22)
                Text("Kong AI Switch")
                    .font(.headline)
                Spacer()
                if let busy = state.busy {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text(busy).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            // Follow the selected agent, not always Claude Code: with Codex
            // selected, showing Claude Code's model would be a lie.
            if let agent = state.selectedAgent, agent.configured {
                HStack(spacing: 6) {
                    BrandMark(kind: .agent(id: agent.id, vendor: agent.vendor), size: 16)
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                    Text(agent.model ?? "unknown")
                        .font(.caption)
                        .fontWeight(.medium)
                    Text("· \(agent.name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack(spacing: 6) {
                    if let agent = state.selectedAgent {
                        BrandMark(kind: .agent(id: agent.id, vendor: agent.vendor), size: 16)
                    }
                    Image(systemName: "circle.dashed")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Text("\(state.selectedAgentName) is not pointed at a gateway")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !state.environments.isEmpty {
                environmentPicker
                Divider()
            }
            if state.gatewaysWithModels.count > 1 {
                gatewayPicker
                Divider()
            }
            if !state.agents.isEmpty {
                agentPicker
                Divider()
            }
            modelList
        }
    }

    /// Which AI Gateway control plane to browse models from.
    ///
    /// One Konnect org can have several gateways; without this picker the
    /// model list mixes them and it looks like there is nothing to switch to.
    private var gatewayPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("AI GATEWAY")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)

            ForEach(state.gatewaysWithModels) { gateway in
                let count = state.models.filter { $0.gatewayId == gateway.id }.count
                Button {
                    state.selectGateway(gateway.id)
                } label: {
                    HStack(spacing: 8) {
                        BrandMark(kind: .kong, size: 20)
                        Image(
                            systemName: gateway.id == state.selectedGatewayId
                                ? "largecircle.fill.circle" : "circle"
                        )
                        .foregroundStyle(
                            gateway.id == state.selectedGatewayId ? Color.accentColor : .secondary
                        )
                        .font(.body)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(gateway.displayName)
                                .font(
                                    .system(
                                        size: 13,
                                        weight: gateway.id == state.selectedGatewayId ? .medium : .regular))
                            Text(gatewaySubtitle(gateway, count: count))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.plain)
            }
            .padding(.bottom, 6)
        }
    }

    private func gatewaySubtitle(_ gateway: SyncedGateway, count: Int) -> String {
        var parts = ["\(count) model\(count == 1 ? "" : "s")"]
        if let proxy = gateway.proxyUrl, !proxy.isEmpty {
            parts.append(proxy)
        } else if let fallback = state.activeEnvironment?.proxyUrl, !fallback.isEmpty {
            parts.append("fallback \(fallback)")
        }
        return parts.joined(separator: " · ")
    }

    private var environmentPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("ENVIRONMENT")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    state.beginSetup()
                } label: {
                    Image(systemName: "plus").font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .help("Add an environment")
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            ForEach(state.environments) { env in
                Button {
                    if !env.active { state.switchEnvironment(to: env.name) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: env.active ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(env.active ? Color.accentColor : .secondary)
                            .font(.body)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(env.label).font(.system(size: 13, weight: env.active ? .medium : .regular))
                            Text(environmentSubtitle(env))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer()
                        if !env.hasToken {
                            Image(systemName: "key.slash")
                                .font(.system(size: 12))
                                .foregroundStyle(.orange)
                                .help("No token set. Choose Edit to add one.")
                        }
                        Button {
                            state.beginSetup(editing: env)
                        } label: {
                            Image(systemName: "pencil").font(.system(size: 12))
                        }
                        .buttonStyle(.plain)
                        .help("Edit \(env.name)")
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Edit…") { state.beginSetup(editing: env) }
                    Button("Remove", role: .destructive) { state.removeEnvironment(env.name) }
                }
            }
            .padding(.bottom, 6)
        }
    }

    private func environmentSubtitle(_ env: KongEnvironment) -> String {
        var parts = ["\(env.region) · \(env.modelCount) model\(env.modelCount == 1 ? "" : "s")"]
        // Prefer the selected gateway's data plane over the env-wide fallback.
        if let proxy = state.activeGateway?.proxyUrl, !proxy.isEmpty {
            parts.append(proxy)
        } else if let proxy = env.proxyUrl, !proxy.isEmpty {
            parts.append(proxy)
        }
        return parts.joined(separator: " · ")
    }

    /// What an agent row says beneath its name: where it points, and how many
    /// models in this environment it can actually reach. Showing the count
    /// here means a mismatch is visible before the list turns up empty.
    private func agentSubtitle(_ agent: Agent) -> String {
        let scoped = state.modelsForGateway
        let reachable = scoped.filter { agent.formats.contains($0.format) }.count
        let where_ = agent.configured ? (agent.model ?? "configured") : "not set"
        guard !scoped.isEmpty else { return where_ }
        return "\(where_) · \(reachable) model\(reachable == 1 ? "" : "s")"
    }

    /// Which coding agent to configure.
    ///
    /// One gateway serves many clients, so this scopes both the model list
    /// and the switch. Each row shows where that agent currently points, so
    /// the whole picture is visible without opening three config files.
    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("CODING AGENT")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)

            ForEach(state.agents) { agent in
                Button {
                    state.selectAgent(agent.id)
                } label: {
                    HStack(spacing: 8) {
                        BrandMark(kind: .agent(id: agent.id, vendor: agent.vendor), size: 22)
                        Image(
                            systemName: agent.id == state.selectedAgentId
                                ? "largecircle.fill.circle" : "circle"
                        )
                        .foregroundStyle(agent.id == state.selectedAgentId ? Color.accentColor : .secondary)
                        .font(.body)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 5) {
                                Text(agent.name)
                                    .font(
                                        .system(
                                            size: 13,
                                            weight: agent.id == state.selectedAgentId ? .medium : .regular))
                                ForEach(agent.formats, id: \.self) { format in
                                    MetaChip(text: format.uppercased())
                                }
                            }
                            Text(agentSubtitle(agent))
                                .font(.system(size: 11))
                                .foregroundStyle(agent.configured ? .secondary : .tertiary)
                        }
                        Spacer()
                        if agent.configured {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11))
                                .foregroundStyle(.green)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .help("\(agent.name) speaks \(agent.formats.joined(separator: "/"))")
            }
            .padding(.bottom, 6)
        }
    }

    private var modelListTitle: String {
        if let gateway = state.activeGateway {
            return "MODELS · \(gateway.displayName.uppercased())"
        }
        return "MODEL FOR \(state.selectedAgentName.uppercased())"
    }

    @ViewBuilder
    private var modelList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(modelListTitle)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)

            if let error = state.errorMessage {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            } else if state.usableModels.isEmpty {
                emptyModelList
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(state.usableModels) { model in
                        modelRow(model)
                    }
                }
            }

            // Hidden-model notice + agent switch links live in normal flow
            // under the model rows — never as an overlay.
            if state.hiddenModelCount > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    Text(
                        "\(state.hiddenModelCount) model\(state.hiddenModelCount == 1 ? "" : "s") hidden: \(state.selectedAgentName) cannot call them."
                    )
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                    // Offer the agents that can use them, so switching is one tap.
                    ForEach(agentsWithModels, id: \.agent.id) { entry in
                        Button {
                            state.selectAgent(entry.agent.id)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.right.circle")
                                    .font(.system(size: 10))
                                Text(
                                    "Show \(entry.count) for \(entry.agent.name)"
                                )
                                .font(.system(size: 11))
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 6)
            }
        }
        .padding(.bottom, 6)
    }

    /// Nothing to show for this agent. Say why, and offer the way out.
    ///
    /// The common case is not "no models" but "models the selected agent
    /// cannot speak to", and the usual remedy is to select a different agent
    /// rather than to change anything in Kong.
    @ViewBuilder
    private var emptyModelList: some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.models.isEmpty {
                Text("No models synced yet. Choose Sync below.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if state.modelsForGateway.isEmpty {
                Text("No models on this gateway. Pick another AI Gateway above.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(
                    "None of the \(state.modelsForGateway.count) models here speak \(state.selectedAgentName)'s protocol."
                )
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                // Point at an agent that can actually use them.
                if !agentsWithModels.isEmpty {
                    ForEach(agentsWithModels, id: \.agent.id) { entry in
                        Button {
                            state.selectAgent(entry.agent.id)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.right.circle")
                                    .font(.system(size: 10))
                                Text(
                                    "\(entry.count) model\(entry.count == 1 ? "" : "s") for \(entry.agent.name)"
                                )
                                .font(.system(size: 11))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                    }
                } else if state.gatewaysWithModels.count > 1 {
                    Text("Try another AI Gateway — other control planes may have matching models.")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(
                        "To use these from \(state.selectedAgentName), set the AI Model's formats[].type in Kong. Kong still translates to whatever upstream provider it targets."
                    )
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// Other agents that could use the models on the selected gateway.
    private var agentsWithModels: [(agent: Agent, count: Int)] {
        state.agents.compactMap { agent in
            guard agent.id != state.selectedAgentId else { return nil }
            // Claude Desktop shares Claude Code's file, so offering both is noise.
            if let shared = agent.sharesConfigWith, shared == state.selectedAgentId { return nil }
            let count = state.modelsForGateway.filter { agent.formats.contains($0.format) }.count
            return count > 0 ? (agent, count) : nil
        }
    }

    private func modelRow(_ model: ModelProfile) -> some View {
        let selected = state.isModelActive(model)
        return HStack(spacing: 10) {
            Button {
                state.use(model: model)
            } label: {
                HStack(spacing: 8) {
                    BrandMark(kind: .format(model.format), size: 20)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : .secondary)
                        .font(.body)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.displayName)
                            .font(.system(size: 13, weight: selected ? .medium : .regular))
                        HStack(spacing: 4) {
                            Text(model.upstreamSummary)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if let provider = model.targets.first?.provider {
                                BrandMark(kind: .provider(provider), size: 14)
                            }
                        }
                        HStack(spacing: 4) {
                            MetaChip(text: model.format.uppercased())
                            if model.hasCredential == true {
                                MetaChip(text: "KEY", tint: .green)
                            } else if state.needsCredentialPrompt(model) {
                                MetaChip(text: "AUTH", tint: .orange)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            authAction(for: model)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contextMenu {
            if model.requiresAuth || model.auth?.required == true {
                Button("Enter credential…") { state.beginCredential(for: model) }
                if model.hasCredential == true {
                    Button("Clear saved key", role: .destructive) { state.clearCredential(for: model) }
                }
            }
        }
    }

    private func modelSubtitle(_ model: ModelProfile) -> String {
        var parts = [model.upstreamSummary]
        if model.hasCredential == true {
            parts.append("key saved")
        } else if state.needsCredentialPrompt(model) {
            parts.append("tap key to enter")
        }
        return parts.joined(separator: " · ")
    }

    /// Visible key control. The user should never need the terminal to paste a credential.
    @ViewBuilder
    private func authAction(for model: ModelProfile) -> some View {
        if model.hasCredential == true {
            Button {
                state.beginCredential(for: model, saveOnly: true)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Key")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(.green)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.green.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Key saved. Click to replace it.")
        } else if state.needsCredentialPrompt(model) {
            Button {
                state.beginCredential(for: model)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "key")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Key")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Enter your API key or OIDC token in the app")
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let toast = state.toast {
                Text(toast)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }

            HStack(spacing: 8) {
                Button("Sync") { state.sync() }
                    .disabled(state.busy != nil || state.environments.isEmpty)
                Button("Refresh") { state.refresh() }
                    .disabled(state.busy != nil)
                if state.selectedAgentId == "claude-desktop" {
                    Button("Desktop…") { state.beginDesktopSettings() }
                        .disabled(state.busy != nil)
                }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .controlSize(.small)
            .padding(12)
        }
    }

    /// First run. The previous version pointed at a CLI command, which is a
    /// dead end in an app whose purpose is not having to use one.
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                BrandMark(kind: .kong, size: 28)
                Text("Kong AI Switch")
                    .font(.headline)
            }
            Text(
                "Connect a Kong AI Gateway to switch Claude Code between the models your platform team publishes."
            )
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            if let error = state.errorMessage {
                // Cap the height: an unexpected stack trace would otherwise
                // push the buttons off the bottom of the panel.
                ScrollView {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
            }

            HStack {
                Button("Add environment") { state.beginSetup() }
                    .keyboardShortcut(.defaultAction)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
        .padding(14)
    }

    private var missingCLI: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(missingCLITitle, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(missingCLIBody)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .controlSize(.small)
        }
        .padding(14)
    }

    private var missingCLITitle: String {
        switch state.cliMissingReason {
        case .missingNode: return "Node.js not found"
        case .missingScript: return "CLI not found"
        case .none: return "CLI not found"
        }
    }

    private var missingCLIBody: String {
        switch state.cliMissingReason {
        case .missingNode:
            return "Kong AI Switch needs Node.js 20+ to run the bundled CLI. Install it with Homebrew (brew install node), then reopen this app."
        case .missingScript:
            return "This app could not find its bundled kong-ai-switch CLI. Re-download KongAISwitch-macOS.zip from the repo, or rebuild with macapp/build-app.sh."
        case .none:
            return "This app drives the kong-ai-switch CLI. Install Node.js 20+, then reopen this app."
        }
    }
}
