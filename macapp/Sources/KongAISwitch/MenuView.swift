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
            } else if state.environments.isEmpty {
                welcome
            } else {
                header
                Divider()
                content
                Divider()
                footer
            }
        }
        .frame(width: 340)
        .onAppear { state.refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
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
                HStack(spacing: 4) {
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
                HStack(spacing: 4) {
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
            if !state.agents.isEmpty {
                agentPicker
                Divider()
            }
            modelList
        }
    }

    private var environmentPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("ENVIRONMENT")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    state.beginSetup()
                } label: {
                    Image(systemName: "plus").font(.system(size: 9))
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
                            .font(.caption)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(env.name).font(.system(size: 12, weight: env.active ? .medium : .regular))
                            Text("\(env.region) · \(env.modelCount) model\(env.modelCount == 1 ? "" : "s")")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !env.hasToken {
                            Image(systemName: "key.slash")
                                .font(.system(size: 10))
                                .foregroundStyle(.orange)
                                .help("No token set. Choose Edit to add one.")
                        }
                        Button {
                            state.beginSetup(editing: env)
                        } label: {
                            Image(systemName: "pencil").font(.system(size: 9))
                        }
                        .buttonStyle(.plain)
                        .help("Edit \(env.name)")
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
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

    /// Which coding agent to configure.
    ///
    /// One gateway serves many clients, so this scopes both the model list
    /// and the switch. Each row shows where that agent currently points, so
    /// the whole picture is visible without opening three config files.
    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("CODING AGENT")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)

            ForEach(state.agents) { agent in
                Button {
                    state.selectAgent(agent.id)
                } label: {
                    HStack(spacing: 6) {
                        Image(
                            systemName: agent.id == state.selectedAgentId
                                ? "largecircle.fill.circle" : "circle"
                        )
                        .foregroundStyle(agent.id == state.selectedAgentId ? Color.accentColor : .secondary)
                        .font(.caption)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(agent.name)
                                .font(
                                    .system(
                                        size: 12,
                                        weight: agent.id == state.selectedAgentId ? .medium : .regular))
                            Text(agent.statusLabel)
                                .font(.system(size: 10))
                                .foregroundStyle(agent.configured ? .secondary : .tertiary)
                        }
                        Spacer()
                        if agent.configured {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9))
                                .foregroundStyle(.green)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .help("\(agent.name) speaks \(agent.formats.joined(separator: "/"))")
            }
            .padding(.bottom, 6)
        }
    }

    @ViewBuilder
    private var modelList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("MODEL FOR \(state.selectedAgentName.uppercased())")
                .font(.system(size: 10, weight: .semibold))
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
                Text(state.environments.isEmpty
                     ? "No environments yet. Create one with the CLI:\nkong-ai-switch env add mine --region us"
                     : "No models synced. Choose Sync below.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(state.usableModels) { model in
                            modelRow(model)
                        }
                    }
                }
                .frame(maxHeight: 220)
            }

            if state.hiddenModelCount > 0 {
                Text("\(state.hiddenModelCount) model\(state.hiddenModelCount == 1 ? "" : "s") hidden: \(state.selectedAgentName) cannot call them.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
        }
        .padding(.bottom, 6)
    }

    private func modelRow(_ model: ModelProfile) -> some View {
        Button {
            state.use(model: model)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: (model.active ?? false) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle((model.active ?? false) ? Color.accentColor : .secondary)
                    .font(.caption)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.displayName)
                        .font(.system(size: 12, weight: (model.active ?? false) ? .medium : .regular))
                    Text(model.upstreamSummary)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.requiresAuth {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .help("Requires a consumer credential")
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
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
            Text("Kong AI Switch")
                .font(.headline)
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
            Label("CLI not found", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text("This app drives the kong-ai-switch command line tool, which it could not locate. Install Node.js and the CLI, then reopen this app.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .controlSize(.small)
        }
        .padding(14)
    }
}
