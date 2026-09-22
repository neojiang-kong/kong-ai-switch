import KongAISwitchCore
import SwiftUI

/// Token-first environment setup.
///
/// The token is the only thing a user genuinely has to supply. Konnect can
/// answer everything else: which gateways exist, their region, how many
/// models they serve, and their data plane address when an operator
/// published one. So the flow asks for the token, goes and looks, and only
/// asks for what Kong could not tell us.
///
/// The one field that cannot always be discovered is the data plane URL.
/// AI Gateway runs hybrid: data plane nodes are self-managed, in the
/// customer's own infrastructure behind their own DNS, and the control plane
/// is never in the path of that traffic. When `proxy_urls` is unset there is
/// genuinely nothing to read, so the form asks rather than guesses.
///
/// Form state lives on `AppState` rather than in `@State`, because the
/// SwiftUI macro plugins backing `@State` ship inside Xcode and this builds
/// against the Command Line Tools alone.
struct SetupView: View {
    @ObservedObject var state: AppState
    var editing: KongEnvironment?

    private var isEditing: Bool { editing != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch state.setupStep {
            case .token: tokenStep
            case .chooseGateway: gatewayStep
            case .confirm: confirmStep
            }
        }
        .padding(14)
        .frame(width: 340)
    }

    // MARK: Step 1 — the token

    private var tokenStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect to Konnect")
                .font(.headline)
            Text("Paste a Konnect token. Your gateways and models are discovered from it.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            SecureField("kpat_...", text: $state.formToken)
                .textFieldStyle(.roundedBorder)
                .onSubmit { state.discoverGateways() }

            Text("Stored in your Keychain. Create one at cloud.konghq.com under Account → Tokens.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            errorText

            HStack {
                Button("Cancel") { state.cancelSetup() }
                Spacer()
                if state.discovering {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text("Searching…").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                } else {
                    Button("Continue") { state.discoverGateways() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(state.formToken.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
    }

    // MARK: Step 2 — which gateway

    private var gatewayStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Choose a gateway")
                .font(.headline)
            Text("\(state.discovered.count) gateways found.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(state.discovered) { gateway in
                        Button {
                            state.chooseGateway(gateway)
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(gateway.displayName).font(.system(size: 12, weight: .medium))
                                Text(gatewaySubtitle(gateway))
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 180)

            HStack {
                Button("Back") { state.backToToken() }
                Spacer()
            }
            .controlSize(.small)
        }
    }

    private func gatewaySubtitle(_ gateway: DiscoveredGateway) -> String {
        var parts = [gateway.region.uppercased()]
        if let count = gateway.modelCount { parts.append("\(count) model\(count == 1 ? "" : "s")") }
        if gateway.needsProxyUrl { parts.append("needs a data plane URL") }
        return parts.joined(separator: " · ")
    }

    // MARK: Step 3 — confirm, and fill any gap

    private var confirmStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(isEditing ? "Edit environment" : "Confirm")
                .font(.headline)

            if let gateway = state.selectedGateway {
                discovered(gateway)
            }

            field("Name") {
                TextField("mine", text: $state.formName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isEditing)  // The CLI treats name as immutable.
            }

            // Only ask for what could not be discovered.
            if state.selectedGateway?.needsProxyUrl ?? true {
                field("Data plane URL") {
                    TextField("http://localhost:8000", text: $state.formProxyUrl)
                        .textFieldStyle(.roundedBorder)
                }
                Text(
                    "Kong could not tell us this: AI Gateway data planes run in your own infrastructure. Use the address your gateway listens on."
                )
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            if isEditing {
                field("Konnect token") {
                    SecureField("leave blank to keep", text: $state.formToken)
                        .textFieldStyle(.roundedBorder)
                }
            }

            errorText

            HStack {
                Button(isEditing ? "Cancel" : "Back") {
                    if isEditing { state.cancelSetup() } else { state.backToToken() }
                }
                Spacer()
                if state.formSaving {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text("Saving…").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                } else {
                    Button(isEditing ? "Save" : "Create") { state.submitSetup() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(state.formName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
    }

    /// What discovery already answered, so the user sees it was not guesswork.
    private func discovered(_ gateway: DiscoveredGateway) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            detail("Gateway", gateway.displayName)
            detail("Region", gateway.region.uppercased())
            if let proxy = gateway.proxyUrl { detail("Data plane", proxy) }
            if let count = gateway.modelCount { detail("Models", "\(count)") }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .frame(width: 66, alignment: .leading)
            Text(value).font(.system(size: 10, weight: .medium))
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var errorText: some View {
        if let error = state.formError {
            Text(error)
                .font(.system(size: 11))
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func field<Content: View>(
        _ label: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}
