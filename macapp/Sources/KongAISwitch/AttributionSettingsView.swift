import KongAISwitchCore
import SwiftUI

/// Cost-attribution headers for the active environment and selected agent.
///
/// Static values land in the agent's config file (`~/.claude/settings.json`
/// or `~/.codex/config.toml`); git-derived values come from a shell wrapper
/// the CLI writes. Each agent lists only the tags it needs headers for.
struct AttributionSettingsView: View {
    @ObservedObject var state: AppState

    private var draft: Binding<AttributionDraft> { $state.attributionDraft }
    private var settings: Binding<AttributionSettings> { $state.attributionDraft.settings }
    private var enabled: Bool { state.attributionDraft.settings.enabled }
    private var agent: AttributionAgent { state.attributionDraft.agent }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(agent == .claudeCode ? "Cost attribution" : "Cost attribution · \(agent.name)")
                    .font(.title3.weight(.semibold))
                Text(
                    "Tags Kong AI cost management reports for \(agent.name): some \(agent.name) "
                        + "sends itself, the rest come from headers you add. Saved for environment "
                        + "“\(state.attributionEnvironment ?? state.activeEnvironmentLabel)”."
                )
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                Toggle("Enable attribution", isOn: settings.enabled)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12, weight: .medium))

                Group {
                    autoSentGroup

                    group("From the headers you add") {
                        caption("Kong reports these \(Self.count(agent.fields.count)) tags from headers kong-ai-switch adds for you.")
                        ForEach(agent.fields, id: \.self) { field in
                            fieldEditor(field)
                        }
                    }

                    group("Additional headers") {
                        caption("Sent as well, beyond the \(Self.count(agent.fields.count)) tags above.")
                        ForEach(agent.additionalFields, id: \.self) { field in
                            fieldEditor(field)
                        }
                        Text("Custom headers")
                            .font(.system(size: 11, weight: .medium))
                        ForEach(settings.headers) { $header in
                            HStack(spacing: 6) {
                                TextField("Name", text: $header.name)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 130)
                                TextField("value", text: $header.value)
                                    .textFieldStyle(.roundedBorder)
                                Button {
                                    state.removeAttributionHeader(header.id)
                                } label: {
                                    Image(systemName: "minus.circle")
                                }
                                .buttonStyle(.plain)
                                .help("Remove this header")
                            }
                        }
                        Button {
                            state.addAttributionHeader()
                        } label: {
                            Label("Add header", systemImage: "plus.circle")
                                .font(.system(size: 12))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                    }

                    previewGroup
                }
                .disabled(!enabled)
                .opacity(enabled ? 1 : 0.45)

                if let problem = state.attributionError ?? state.attributionDraft.validationError {
                    Text(problem)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack {
                    Button("Cancel") { state.cancelAttributionSettings() }
                    Spacer()
                    if state.attributionSaving {
                        ProgressView().controlSize(.small)
                    }
                    Button("Save") { state.submitAttributionSettings() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(state.attributionSaving)
                }
                .controlSize(.regular)
                .padding(.top, 4)
            }
            .padding(14)
        }
        .frame(width: 380, height: 560)
    }

    private static func count(_ n: Int) -> String {
        let words = ["no", "one", "two", "three", "four"]
        return n < words.count ? words[n] : "\(n)"
    }

    @ViewBuilder
    private func fieldEditor(_ field: AttributionField) -> some View {
        switch field {
        case .scmProvider:
            tagField(field.tag, header: field.header) {
                Picker("Provider", selection: draft.scmChoice) {
                    Text("Not set").tag("")
                    ForEach(Attribution.scmProviders, id: \.self) { provider in
                        Text(provider).tag(provider)
                    }
                    Text("Custom…").tag(AttributionDraft.customProvider)
                }
                .labelsHidden()
                if state.attributionDraft.scmChoice == AttributionDraft.customProvider {
                    TextField("provider name", text: draft.scmCustom)
                        .textFieldStyle(.roundedBorder)
                }
            }
        case .repository:
            gitField(
                field.tag,
                header: field.header,
                auto: settings.repositoryAuto,
                value: settings.repository,
                placeholder: "acme/payments-api",
                autoHint: "owner/repo from `git remote get-url origin`"
            )
        case .branch:
            gitField(
                field.tag,
                header: field.header,
                auto: settings.branchAuto,
                value: settings.branch,
                placeholder: "main",
                autoHint: "from `git branch --show-current`"
            )
        case .project:
            tagField(field.tag, header: field.header) {
                TextField("payments-api", text: settings.project)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private var autoSentGroup: some View {
        let hintsOn = agent.supportsHintHeaders && state.attributionDraft.settings.hintHeaders
        return group("Sent by \(agent.name) automatically") {
            caption(
                agent.supportsHintHeaders
                    ? "\(agent.name) sends these itself; nothing to configure. Two need the hint toggle below."
                    : "\(agent.name) sends these itself; nothing to configure."
            )
            VStack(alignment: .leading, spacing: 3) {
                ForEach(agent.autoSentTags, id: \.self) { tag in
                    let sent = !tag.needsHintHeaders || hintsOn
                    HStack(spacing: 6) {
                        Image(systemName: sent ? "checkmark.circle.fill" : "minus.circle")
                            .foregroundStyle(sent ? Color.green : Color.secondary)
                            .font(.system(size: 11))
                        Text(tag.name)
                            .font(.system(size: 12))
                            .foregroundStyle(sent ? .primary : .secondary)
                        Spacer()
                        if tag.needsHintHeaders {
                            Text(hintsOn ? "hint headers" : "not sent")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if agent.supportsHintHeaders {
                Toggle("Send gateway hint headers", isOn: settings.hintHeaders)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12))
                    .padding(.top, 2)
                caption("Sets CLAUDE_CODE_GATEWAY_HINT_HEADERS=1, which makes Claude Code send Agent request kind and Agent type.")
                if !hintsOn {
                    Text("Off: Agent request kind and Agent type won't be sent.")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var previewGroup: some View {
        group("Preview") {
            let preview = state.attributionDraft.preview
            Text(
                agent == .codex
                    ? "config.toml http_headers (plus your gateway key, if any)"
                    : "ANTHROPIC_CUSTOM_HEADERS (plus your gateway key, if any)"
            )
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            Text(preview.isEmpty ? "(no headers)" : preview)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
            if agent.supportsHintHeaders && state.attributionDraft.settings.hintHeaders {
                Text("CLAUDE_CODE_GATEWAY_HINT_HEADERS=1")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if state.attributionDraft.resolved.usesAutoGit {
                Text("Add to ~/.zshrc (once), then open a new terminal:")
                    .font(.system(size: 11, weight: .medium))
                    .padding(.top, 4)
                Text(agent.sourceLine)
                    .font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
                HStack {
                    Button("Copy line") { state.copyAttributionSourceLine() }
                        .controlSize(.small)
                    Spacer()
                }
                caption(
                    agent == .codex
                        ? "config.toml cannot run git, so it maps ai-cost-scm-branch to "
                            + "\(Attribution.codexBranchEnv) (env_http_headers), and the next Codex switch "
                            + "writes ~/.kong-ai-switch/codex-attribution.sh with a codex() wrapper that sets "
                            + "it from git at launch. Your rc files are never edited. Launches outside that "
                            + "shell send the static headers without a branch."
                        : "settings.json cannot run git, so the next Claude Code switch writes "
                            + "~/.kong-ai-switch/claude-attribution.sh with a claude() wrapper that adds "
                            + "repository and branch at launch. Your rc files are never edited. "
                            + "Launches outside that shell (e.g. IDEs) still send the static headers."
                )
            }
        }
    }

    private func gitField(
        _ title: String, header: String, auto: Binding<Bool>, value: Binding<String>,
        placeholder: String, autoHint: String
    ) -> some View {
        tagField(title, header: header) {
            Picker(title, selection: auto) {
                Text("Fixed value").tag(false)
                Text("Auto from git").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if auto.wrappedValue {
                caption("Detected when \(agent.name) starts: \(autoHint).")
            } else {
                TextField(placeholder, text: value)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func group<Content: View>(
        _ title: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            content()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }

    /// Field titled by the reported tag, with the header it travels in.
    private func tagField<Content: View>(
        _ title: String, header: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                Text(header)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            content()
        }
    }
}
