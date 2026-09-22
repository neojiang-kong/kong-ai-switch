import AppKit
import KongAISwitchCore
import SwiftUI

/// Ask for the credential a model's auth strategy needs.
///
/// The two strategies are not interchangeable, so the form is not either:
///
///   key-auth        a long-lived key. Offered first when a model accepts
///                   both, and saved to the Keychain so the next switch
///                   needs nothing.
///
///   openid-connect  a bearer token that expires in minutes. Accepted for
///                   this switch and deliberately not stored, because a
///                   stale token fails mid-session with a 401 that looks
///                   like a gateway fault.
struct CredentialView: View {
    @ObservedObject var state: AppState
    let profile: ModelProfile

    private var auth: ModelAuth? { profile.auth }

    /// Whether the user is entering a key or a bearer token.
    private var usingKeyAuth: Bool {
        state.credentialUseKeyAuth
    }

    private var chosen: AuthStrategy? {
        usingKeyAuth ? auth?.keyAuth : auth?.oidc
    }

    private var canStoreKey: Bool {
        auth?.keyAuth != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(state.credentialSaveOnly ? "Update key" : "Enter credential")
                .font(.title3.weight(.semibold))
            Text(headerText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // Only offer a choice when the model actually accepts both.
            if auth?.hasChoice == true, auth?.keyAuth != nil, auth?.oidc != nil {
                Picker("", selection: $state.credentialUseKeyAuth) {
                    Text("API key").tag(true)
                    Text("OIDC token").tag(false)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .controlSize(.large)
            }

            if let strategy = chosen {
                strategyDetail(strategy)
            }

            if !usingKeyAuth {
                oidcHelp
            }

            SecureField(usingKeyAuth ? "your API key" : "bearer token", text: $state.credentialValue)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .onSubmit { state.submitCredential(for: profile) }

            if usingKeyAuth {
                Toggle("Remember in Keychain", isOn: $state.credentialRemember)
                    .font(.system(size: 12))
                    .toggleStyle(.checkbox)
            } else {
                Text("Not stored: OIDC tokens expire, and a stale one fails mid-session.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = state.credentialError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button("Cancel") { state.cancelCredential() }
                Spacer()
                if state.busy != nil {
                    ProgressView().controlSize(.small)
                } else {
                    actionButtons
                }
            }
            .controlSize(.regular)
            .padding(.top, 2)
        }
        .padding(14)
        .frame(width: 380)
    }

    private var headerText: String {
        if state.credentialSaveOnly {
            return "Paste a new API key for \(profile.displayName). It is saved in your Keychain."
        }
        if usingKeyAuth {
            return "Paste your API key for \(profile.displayName). It stays in your Keychain for next time."
        }
        return "Paste a fresh OIDC bearer token for \(profile.displayName). It is used once and not stored."
    }

    @ViewBuilder
    private var actionButtons: some View {
        if state.credentialSaveOnly {
            Button("Save") { state.submitCredential(for: profile) }
                .keyboardShortcut(.defaultAction)
                .disabled(state.credentialValue.isEmpty || !usingKeyAuth)
        } else if usingKeyAuth && canStoreKey {
            Button("Save key") { state.saveCredentialOnly(for: profile) }
                .disabled(state.credentialValue.isEmpty)
            Button("Switch") { state.submitCredential(for: profile) }
                .keyboardShortcut(.defaultAction)
                .disabled(state.credentialValue.isEmpty)
        } else {
            Button("Switch") { state.submitCredential(for: profile) }
                .keyboardShortcut(.defaultAction)
                .disabled(state.credentialValue.isEmpty)
        }
    }

    @ViewBuilder
    private var oidcHelp: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Get a bearer token from your identity provider, then paste it here.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Typical flow: sign in to Keycloak (or your IdP), copy the access token, paste above.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let issuer = auth?.oidc?.issuer, let url = URL(string: issuer) {
                Button("Open issuer in browser") {
                    NSWorkspace.shared.open(url)
                }
                .controlSize(.small)
            }
        }
    }

    private func strategyDetail(_ strategy: AuthStrategy) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Text("Strategy")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .frame(width: 54, alignment: .leading)
                Text(strategy.label).font(.system(size: 10, weight: .medium))
                Spacer(minLength: 0)
            }
            if let header = strategy.header, strategy.isKeyAuth {
                HStack(alignment: .top, spacing: 6) {
                    Text("Header")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .frame(width: 54, alignment: .leading)
                    Text(header).font(.system(size: 10, weight: .medium))
                    Spacer(minLength: 0)
                }
            }
            if let issuer = strategy.issuer {
                HStack(alignment: .top, spacing: 6) {
                    Text("Issuer")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .frame(width: 54, alignment: .leading)
                    Text(issuer)
                        .font(.system(size: 10, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
            if let hint = strategy.hint {
                Text(hint)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
    }
}
