import KongAISwitchCore
import SwiftUI

/// Create or edit an environment without leaving the app.
///
/// Telling someone to go run a CLI is a poor first run for a tool whose whole
/// point is not having to. This collects the four things an environment needs
/// and hands them to the CLI, which stays the single implementation.
///
/// Form fields live on `AppState` rather than in `@State`, because the SwiftUI
/// macro plugins backing `@State` ship inside Xcode and this project builds
/// against the Command Line Tools alone.
struct SetupView: View {
    @ObservedObject var state: AppState
    var editing: KongEnvironment?

    private let regions = ["us", "eu", "au", "me", "in", "sg"]

    private var isEditing: Bool { editing != nil }

    private var canSave: Bool {
        !state.formName.trimmingCharacters(in: .whitespaces).isEmpty && !state.formSaving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(isEditing ? "Edit environment" : "New environment")
                    .font(.headline)
                Spacer()
                if state.formSaving {
                    ProgressView().controlSize(.small)
                }
            }

            field("Name") {
                TextField("mine", text: $state.formName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isEditing)  // The CLI treats name as immutable.
            }

            field("Region") {
                Picker("", selection: $state.formRegion) {
                    ForEach(regions, id: \.self) { Text($0.uppercased()).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }

            field("Data plane URL") {
                TextField("http://localhost:8000", text: $state.formProxyUrl)
                    .textFieldStyle(.roundedBorder)
            }

            field("Konnect token") {
                SecureField(isEditing ? "leave blank to keep" : "kpat_...", text: $state.formToken)
                    .textFieldStyle(.roundedBorder)
            }

            Text("Stored in your Keychain. Create one at cloud.konghq.com under Account → Tokens.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let error = state.formError {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button("Cancel") { state.cancelSetup() }
                Spacer()
                Button(isEditing ? "Save" : "Create") { state.submitSetup() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
        .padding(14)
        .frame(width: 340)
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
