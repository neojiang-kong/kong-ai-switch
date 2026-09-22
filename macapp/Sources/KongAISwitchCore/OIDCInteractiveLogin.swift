import CryptoKit
import Foundation
import Network

/// Claude Desktop–style interactive OIDC: authorization code + PKCE with a
/// loopback redirect (`http://127.0.0.1:<port>/callback`).
///
/// The IdP must register the same public client id and exact redirect URI
/// (Keycloak/Okta require an exact port match). Defaults match Claude Desktop:
/// `claude-desktop` on port `53180`.
public struct OIDCLoginConfig: Sendable, Equatable {
    public var issuer: String
    public var clientId: String
    public var redirectPort: UInt16
    public var scopes: [String]

    public init(
        issuer: String,
        clientId: String = "claude-desktop",
        redirectPort: UInt16 = 53180,
        scopes: [String] = ["openid", "profile", "email", "offline_access"]
    ) {
        self.issuer = issuer
        self.clientId = clientId
        self.redirectPort = redirectPort
        self.scopes = scopes
    }

    public var redirectURI: String {
        "http://127.0.0.1:\(redirectPort)/callback"
    }
}

public struct OIDCTokens: Sendable, Equatable {
    public let accessToken: String
    public let idToken: String?
    public let refreshToken: String?
    public let expiresIn: Int?
    public let tokenType: String?

    public init(
        accessToken: String, idToken: String? = nil, refreshToken: String? = nil,
        expiresIn: Int? = nil, tokenType: String? = nil
    ) {
        self.accessToken = accessToken
        self.idToken = idToken
        self.refreshToken = refreshToken
        self.expiresIn = expiresIn
        self.tokenType = tokenType
    }
}

public enum OIDCLoginError: Error, LocalizedError, Sendable {
    case invalidIssuer
    case discoveryFailed(String)
    case missingAuthorizationEndpoint
    case missingTokenEndpoint
    case portInUse(UInt16)
    case cancelled
    case idpError(String)
    case missingCode
    case stateMismatch
    case tokenExchangeFailed(String)
    case missingAccessToken

    public var errorDescription: String? {
        switch self {
        case .invalidIssuer:
            return "OIDC issuer URL is missing or invalid."
        case .discoveryFailed(let detail):
            return "Could not load OIDC discovery document: \(detail)"
        case .missingAuthorizationEndpoint:
            return "OIDC discovery document has no authorization_endpoint."
        case .missingTokenEndpoint:
            return "OIDC discovery document has no token_endpoint."
        case .portInUse(let port):
            return "Port \(port) is in use (another app may be signing in). Quit Claude Desktop or free that port, then try again."
        case .cancelled:
            return "Sign-in cancelled."
        case .idpError(let detail):
            return "Identity provider error: \(detail)"
        case .missingCode:
            return "Sign-in callback did not include an authorization code."
        case .stateMismatch:
            return "Sign-in state did not match. Try again."
        case .tokenExchangeFailed(let detail):
            return "Token exchange failed: \(detail)"
        case .missingAccessToken:
            return "Token response did not include an access_token."
        }
    }
}

/// Runs one interactive browser login and returns tokens.
public final class OIDCInteractiveLogin: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// Discover endpoints, open `authorizationURL` via the caller, wait for the
    /// loopback callback, exchange the code, then tear the listener down.
    public func signIn(
        config: OIDCLoginConfig,
        openURL: @escaping @Sendable (URL) -> Void
    ) async throws -> OIDCTokens {
        let discovery = try await fetchDiscovery(issuer: config.issuer)
        guard let authEndpoint = discovery.authorizationEndpoint else {
            throw OIDCLoginError.missingAuthorizationEndpoint
        }
        guard let tokenEndpoint = discovery.tokenEndpoint else {
            throw OIDCLoginError.missingTokenEndpoint
        }

        let verifier = PKCE.generateVerifier()
        let challenge = PKCE.challenge(for: verifier)
        let state = PKCE.generateVerifier(length: 32)

        var comps = URLComponents(string: authEndpoint)!
        comps.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: config.clientId),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "scope", value: config.scopes.joined(separator: " ")),
        ]
        guard let authURL = comps.url else { throw OIDCLoginError.invalidIssuer }

        let callback = try await LoopbackCallbackServer.waitForCallback(
            port: config.redirectPort,
            expectedPath: "/callback",
            open: { openURL(authURL) }
        )

        if let err = callback["error"] {
            let desc = callback["error_description"] ?? err
            throw OIDCLoginError.idpError(desc.replacingOccurrences(of: "+", with: " "))
        }
        guard let code = callback["code"], !code.isEmpty else {
            throw OIDCLoginError.missingCode
        }
        guard callback["state"] == state else {
            throw OIDCLoginError.stateMismatch
        }

        return try await exchangeCode(
            tokenEndpoint: tokenEndpoint,
            code: code,
            verifier: verifier,
            config: config
        )
    }

    // MARK: - Discovery / token

    private struct Discovery: Decodable {
        let authorizationEndpoint: String?
        let tokenEndpoint: String?

        enum CodingKeys: String, CodingKey {
            case authorizationEndpoint = "authorization_endpoint"
            case tokenEndpoint = "token_endpoint"
        }
    }

    private func fetchDiscovery(issuer: String) async throws -> Discovery {
        let trimmed = issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: trimmed) else { throw OIDCLoginError.invalidIssuer }
        let url = base.appendingPathComponent(".well-known/openid-configuration")
        do {
            let (data, response) = try await session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                throw OIDCLoginError.discoveryFailed("HTTP \(status)")
            }
            return try JSONDecoder().decode(Discovery.self, from: data)
        } catch let error as OIDCLoginError {
            throw error
        } catch {
            throw OIDCLoginError.discoveryFailed(error.localizedDescription)
        }
    }

    private struct TokenResponse: Decodable {
        let accessToken: String?
        let idToken: String?
        let refreshToken: String?
        let expiresIn: Int?
        let tokenType: String?
        let error: String?
        let errorDescription: String?

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case idToken = "id_token"
            case refreshToken = "refresh_token"
            case expiresIn = "expires_in"
            case tokenType = "token_type"
            case error
            case errorDescription = "error_description"
        }
    }

    private func exchangeCode(
        tokenEndpoint: String,
        code: String,
        verifier: String,
        config: OIDCLoginConfig
    ) async throws -> OIDCTokens {
        guard let url = URL(string: tokenEndpoint) else {
            throw OIDCLoginError.missingTokenEndpoint
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body: [URLQueryItem] = [
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI),
            URLQueryItem(name: "client_id", value: config.clientId),
            URLQueryItem(name: "code_verifier", value: verifier),
        ]
        request.httpBody = Self.formURLEncoded(body).data(using: .utf8)

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data)
        if let err = decoded?.error {
            throw OIDCLoginError.tokenExchangeFailed(decoded?.errorDescription ?? err)
        }
        guard (200..<300).contains(status) else {
            let raw = String(data: data, encoding: .utf8) ?? "HTTP \(status)"
            throw OIDCLoginError.tokenExchangeFailed(raw)
        }
        guard let access = decoded?.accessToken, !access.isEmpty else {
            throw OIDCLoginError.missingAccessToken
        }
        return OIDCTokens(
            accessToken: access,
            idToken: decoded?.idToken,
            refreshToken: decoded?.refreshToken,
            expiresIn: decoded?.expiresIn,
            tokenType: decoded?.tokenType
        )
    }

    static func formURLEncoded(_ items: [URLQueryItem]) -> String {
        items.compactMap { item -> String? in
            guard let value = item.value else { return nil }
            let name = item.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? item.name
            let encoded =
                value.addingPercentEncoding(withAllowedCharacters: Self.formAllowed) ?? value
            return "\(name)=\(encoded)"
        }.joined(separator: "&")
    }

    private static let formAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()
}

// MARK: - PKCE

enum PKCE {
    static func generateVerifier(length: Int = 64) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }
}

extension Data {
    fileprivate func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - Loopback HTTP callback

enum LoopbackCallbackServer {
    /// Bind `127.0.0.1:port`, invoke `open` (browser), then resolve with the
    /// first GET query dictionary for `expectedPath`.
    static func waitForCallback(
        port: UInt16,
        expectedPath: String,
        open: @escaping @Sendable () -> Void
    ) async throws -> [String: String] {
        let holder = ListenerHolder()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let box = ResumeBox(continuation)
                let listener: NWListener
                do {
                    listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
                } catch {
                    continuation.resume(throwing: OIDCLoginError.portInUse(port))
                    return
                }
                holder.listener = listener

                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        open()
                    case .failed(let error):
                        box.resume(throwing: mapListenerError(error, port: port))
                        listener.cancel()
                    case .cancelled:
                        box.resume(throwing: OIDCLoginError.cancelled)
                    default:
                        break
                    }
                }

                listener.newConnectionHandler = { connection in
                    connection.start(queue: .global(qos: .userInitiated))
                    receiveHTTP(on: connection) { result in
                        switch result {
                        case .failure(let error):
                            box.resume(throwing: error)
                        case .success(let request):
                            let path = URLComponents(string: request.path)?.path ?? request.path
                            if path == expectedPath {
                                let html = """
                                <!doctype html><html><body style="font-family:system-ui;padding:2rem">
                                <h2>Signed in</h2>
                                <p>You can close this tab and return to Kong AI Switch.</p>
                                </body></html>
                                """
                                respond(connection, status: 200, body: html)
                                box.resume(returning: request.query)
                            } else {
                                respond(connection, status: 404, body: "Not found")
                                return
                            }
                        }
                        listener.cancel()
                    }
                }

                listener.start(queue: .global(qos: .userInitiated))
            }
        } onCancel: {
            holder.cancel()
        }
    }

    private static func mapListenerError(_ error: NWError, port: UInt16) -> OIDCLoginError {
        if case .posix(let code) = error, code == .EADDRINUSE {
            return .portInUse(port)
        }
        return .portInUse(port)
    }

    private struct HTTPRequest {
        let path: String
        let query: [String: String]
    }

    private static func receiveHTTP(
        on connection: NWConnection,
        completion: @escaping (Result<HTTPRequest, Error>) -> Void
    ) {
        var buffer = Data()
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    completion(.failure(error))
                    return
                }
                if let data { buffer.append(data) }
                if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    let headerData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                    let header = String(data: headerData, encoding: .utf8) ?? ""
                    let first = header.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
                    // GET /callback?code=... HTTP/1.1
                    let parts = first.split(separator: " ")
                    guard parts.count >= 2 else {
                        completion(.failure(OIDCLoginError.missingCode))
                        return
                    }
                    let target = String(parts[1])
                    var query: [String: String] = [:]
                    if let comps = URLComponents(string: target) {
                        for item in comps.queryItems ?? [] {
                            if let value = item.value { query[item.name] = value }
                        }
                        completion(.success(HTTPRequest(path: comps.path, query: query)))
                    } else {
                        completion(.success(HTTPRequest(path: target, query: [:])))
                    }
                    return
                }
                if isComplete {
                    completion(.failure(OIDCLoginError.missingCode))
                    return
                }
                readMore()
            }
        }
        readMore()
    }

    private static func respond(_ connection: NWConnection, status: Int, body: String) {
        let reason = status == 200 ? "OK" : "Error"
        let payload = Data(body.utf8)
        let header = """
        HTTP/1.1 \(status) \(reason)\r
        Content-Type: text/html; charset=utf-8\r
        Content-Length: \(payload.count)\r
        Connection: close\r
        \r

        """
        var message = Data(header.utf8)
        message.append(payload)
        connection.send(content: message, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

/// Holds the NWListener so Task cancellation can tear it down.
private final class ListenerHolder: @unchecked Sendable {
    var listener: NWListener?
    func cancel() { listener?.cancel() }
}

/// Resume a continuation at most once.
private final class ResumeBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    init(_ continuation: CheckedContinuation<T, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: T) {
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume(throwing: error)
    }
}
