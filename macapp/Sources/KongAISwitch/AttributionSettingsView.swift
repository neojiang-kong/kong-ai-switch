import KongAISwitchCore
import SwiftUI

/// Claude Code cost-attribution headers for the active environment.
///
/// Static values land in `~/.claude/settings.json`; repository and branch can
/// instead come from git at launch through a shell wrapper the CLI writes.
struct AttributionSettingsView: View {
    @ObservedObject var state: AppState

    private var draft: Binding<AttributionDraft> { $state.attributionDraft }
    private var settings: Binding<AttributionSettings> { $state.attributionDraft.settings }
    private var enabled: Bool { state.attributionDraft.settings.enabled }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Cost attribution")
                    .font(.title3.weight(.semibold))
                Text(
                    "Tags Kong AI cost management reports for Claude Code: some Claude Code "
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
                        caption("Kong reports these three tags from headers kong-ai-switch adds for you.")
                        tagField("Source control provider", header: Attribution.scmProviderHeader) {
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
                        gitField(
                            "Repository",
                            header: Attribution.repositoryHeader,
                            auto: settings.repositoryAuto,
                            value: settings.repository,
                            placeholder: "acme/payments-api",
                            autoHint: "owner/repo from `git remote get-url origin`"
                        )
                        gitField(
                            "Branch",
                            header: Attribution.branchHeader,
                            auto: settings.branchAuto,
                            value: settings.branch,
                            placeholder: "main",
                            autoHint: "from `git branch --show-current`"
                        )
                    }

                    group("Additional headers") {
                        caption("Sent as well, beyond the three tags above.")
                        tagField("Project", header: Attribution.projectHeader) {
                            TextField("payments-api", text: settings.project)
                                .textFieldStyle(.roundedBorder)
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

    private var autoSentGroup: some View {
        let hintsOn = state.attributionDraft.settings.hintHeaders
        return group("Sent by Claude Code automatically") {
            caption("Claude Code sends these itself; nothing to configure. Two need the hint toggle below.")
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Attribution.autoSentTags, id: \.self) { tag in
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

    private var previewGroup: some View {
        group("Preview") {
            let preview = state.attributionDraft.preview
            Text("ANTHROPIC_CUSTOM_HEADERS (plus your gateway key, if any)")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(preview.isEmpty ? "(no headers)" : preview)
                .font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
            if state.attributionDraft.settings.hintHeaders {
                Text("CLAUDE_CODE_GATEWAY_HINT_HEADERS=1")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if state.attributionDraft.resolved.usesAutoGit {
                Text("Add to ~/.zshrc (once), then open a new terminal:")
                    .font(.system(size: 11, weight: .medium))
                    .padding(.top, 4)
                Text(Attribution.sourceLine)
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
                    "settings.json cannot run git, so the next Claude Code switch writes "
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
                caption("Detected when Claude Code starts: \(autoHint).")
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
