import SwiftUI

/// Claude Desktop configLibrary writer options.
///
/// Bound to `AppState.desktopPrefs` and persisted in UserDefaults so every
/// switch matches a working Desktop-exported profile without Terminal defaults
/// or hand-editing JSON.
struct DesktopSettingsView: View {
    @ObservedObject var state: AppState

    private var prefs: Binding<DesktopWriterPrefs> {
        $state.desktopPrefs
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Claude Desktop")
                    .font(.title3.weight(.semibold))
                Text(
                    "Options written into Claude Desktop’s configLibrary profile. "
                        + "Interactive OIDC never includes an API key."
                )
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                group("Credential") {
                    Picker("Mode", selection: prefs.credentialMode) {
                        ForEach(DesktopCredentialMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    Text(
                        prefs.wrappedValue.credentialMode == .staticJWT
                            ? "Writes a static Bearer JWT (inferenceGatewayApiKey)."
                            : "Writes interactive OIDC only — Claude Desktop runs browser login."
                    )
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                group("Profile") {
                    Toggle("Model discovery", isOn: prefs.modelDiscovery)
                    Toggle("Trailing slash on base URL", isOn: prefs.trailingSlash)
                    Toggle("Label override when name ≠ model id", isOn: prefs.labelOverride)
                }
                .toggleStyle(.checkbox)
                .font(.system(size: 12))

                group("OIDC client") {
                    labeledField("Entra Client ID") {
                        TextField(
                            "Application (client) ID GUID",
                            text: prefs.oidcClientIdEntra
                        )
                        .textFieldStyle(.roundedBorder)
                    }
                    labeledField("Other IdPs (optional)") {
                        TextField("claude-desktop", text: prefs.oidcClientId)
                            .textFieldStyle(.roundedBorder)
                    }
                    labeledField("Redirect port") {
                        TextField(
                            "53180",
                            value: prefs.oidcRedirectPort,
                            format: .number
                        )
                        .textFieldStyle(.roundedBorder)
                    }
                    Text(
                        "Entra Client ID is only used for Microsoft Entra issuers. "
                            + "Keycloak and other IdPs use the optional override, or the "
                            + "agent default (claude-desktop for Claude)."
                    )
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                group("OIDC (interactive profile)") {
                    labeledField("Scopes") {
                        TextField("openid profile email", text: prefs.oidcScopes)
                            .textFieldStyle(.roundedBorder)
                    }
                    Picker("Bearer token", selection: prefs.oidcBearerTokenType) {
                        ForEach(OIDCBearerTokenType.allCases) { type in
                            Text(type.label).tag(type)
                        }
                    }
                    .font(.system(size: 12))
                    Picker("Auth flow", selection: prefs.oidcAuthFlow) {
                        ForEach(OIDCAuthFlow.allCases) { flow in
                            Text(flow.rawValue).tag(flow)
                        }
                    }
                    .font(.system(size: 12))
                    Toggle("Append offline_access", isOn: prefs.oidcAppendOfflineAccess)
                        .toggleStyle(.checkbox)
                        .font(.system(size: 12))
                }
                .disabled(prefs.wrappedValue.credentialMode != .interactive)
                .opacity(prefs.wrappedValue.credentialMode == .interactive ? 1 : 0.45)

                HStack {
                    Button("Cancel") { state.cancelDesktopSettings() }
                    Spacer()
                    Button("Save") { state.submitDesktopSettings() }
                        .keyboardShortcut(.defaultAction)
                }
                .controlSize(.regular)
                .padding(.top, 4)
            }
            .padding(14)
        }
        .frame(width: 380, height: 520)
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

    private func labeledField<Content: View>(
        _ label: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            content()
        }
    }
}
