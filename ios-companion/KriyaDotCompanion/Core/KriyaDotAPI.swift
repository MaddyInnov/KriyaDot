// SPDX-License-Identifier: Apache-2.0
import Foundation

enum APIError: Error, LocalizedError {
    case http(Int, String)
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .http(let code, let detail):
            return detail.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(detail)"
        case .server(let message):
            return message
        case .invalidResponse:
            return "Invalid response from server"
        }
    }
}

/// REST client for the KriyaDot companion API (phone -> PC direction).
///
/// Identical contract to android-companion's KriyaDotApi.kt:
///   POST /api/companion/pairing/exchange {ott, deviceName, platform} -> {ok, deviceToken, deviceId, pushKey}
///   GET  /api/companion/status        -> health + active runs summary + pending approvals count
///   GET  /api/companion/approvals     -> pending approvals
///   POST /api/companion/approvals/:id/approve | /deny {note?}
///   GET  /api/companion/runs
///   POST /api/companion/runs/:id/pause | /resume | /cancel
///   GET  /api/companion/activity      -> activity feed
///   GET  /api/companion/briefing      -> latest digest
///   GET  /api/companion/bots          -> bot roster for the chat picker
///   POST /api/chat                    -> chat turn (SSE stream)
///
/// All calls except the pairing exchange carry
/// `Authorization: Bearer <deviceToken>`.
final class KriyaDotAPI {
    private let store: PairingStore
    private let session: URLSession

    init(store: PairingStore, session: URLSession? = nil) {
        self.store = store
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: config)
        }
    }

    // MARK: - Pairing

    /// One-time exchange: QR ott -> long-lived device token. Stores nothing.
    /// baseUrl is the http(s) server root (LAN "http://host:port" or a
    /// hosted https URL from the QR payload). Sends platform "ios" (the
    /// server's exchange accepts an optional platform field; Android sends
    /// its own the same way by omission/default — see companion.ts).
    func exchangePairing(baseUrl: String, ott: String, deviceName: String) async throws -> PairingResult {
        let body = jsonBody(["ott": ott, "deviceName": deviceName, "platform": "ios"])
        let json = try await awaitJSON(request(url: "\(baseUrl)/api/companion/pairing/exchange", method: "POST", body: body, authorized: false))
        guard json.optBool("ok", false) else {
            throw APIError.server(json.optString("error", "Pairing exchange failed"))
        }
        let token = json.optString("deviceToken").isEmpty ? json.optString("token") : json.optString("deviceToken")
        if token.isEmpty { throw APIError.server("Server did not return a device token") }
        return PairingResult(
            deviceToken: token,
            deviceId: json.optString("deviceId", ""),
            pushKey: json.optString("pushKey", "")
        )
    }

    // MARK: - Push registration (APNs)

    /// Registers this device's APNs token so the server can push "done" /
    /// "needs you" notifications while the app is backgrounded.
    ///
    /// Uses the SAME registration endpoint Android uses for its FCM token
    /// (POST /api/companion/devices/:id/fcm-token), adapted with an
    /// explicit token type: the body carries {token, tokenType: "apns",
    /// platform: "ios", apnsToken}. IMPORTANT: the server today only
    /// implements the FCM branch of this endpoint (companion-routes.ts
    /// reads `fcmToken` and PushService sends via FCM only) — there is no
    /// APNs send path on the server yet. This call is therefore
    /// best-effort: failures are swallowed (the WebSocket covers the
    /// foreground case), and the README documents the server contract
    /// needed to light APNs up. Nothing here fakes a send.
    func registerPushToken(_ apnsTokenHex: String) async -> Bool {
        do {
            let json = try await post(
                "/api/companion/devices/\(store.deviceId)/fcm-token",
                body: [
                    "token": apnsTokenHex,
                    "tokenType": "apns",
                    "platform": "ios",
                    "apnsToken": apnsTokenHex,
                ]
            )
            return json.optBool("ok", false)
        } catch {
            return false
        }
    }

    // MARK: - Authed helpers

    private func request(url: String, method: String, body: Data? = nil, authorized: Bool = true) -> URLRequest {
        // Malformed manual-entry hosts surface as a request error, not a crash.
        var req = URLRequest(url: URL(string: url) ?? URL(string: "about:blank")!)
        req.httpMethod = method
        if authorized {
            req.setValue("Bearer \(store.deviceToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func authedRequest(path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        request(url: store.baseUrl + path, method: method, body: body)
    }

    private func awaitJSON(_ req: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, jsonObject(data).optString("error"))
        }
        return jsonObject(data)
    }

    private func post(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        try await awaitJSON(authedRequest(path: path, method: "POST", body: jsonBody(body ?? [:])))
    }

    // MARK: - Status / approvals / runs / activity / briefing

    func getStatus() async throws -> ServerStatus {
        ServerStatus.from(json: try await awaitJSON(authedRequest(path: "/api/companion/status")))
    }

    func getApprovals() async throws -> [Approval] {
        Approval.list(from: try await awaitJSON(authedRequest(path: "/api/companion/approvals")))
    }

    func getRuns() async throws -> [RunSummary] {
        RunSummary.list(from: try await awaitJSON(authedRequest(path: "/api/companion/runs")))
    }

    func approve(id: String, note: String?) async throws -> [String: Any] {
        try await post("/api/companion/approvals/\(id)/approve", body: noteBody(note))
    }

    func deny(id: String, note: String?) async throws -> [String: Any] {
        try await post("/api/companion/approvals/\(id)/deny", body: noteBody(note))
    }

    private func noteBody(_ note: String?) -> [String: Any] {
        guard let note, !note.trimmingCharacters(in: .whitespaces).isEmpty else { return [:] }
        return ["note": note]
    }

    func pauseRun(id: String) async throws -> [String: Any] {
        try await post("/api/companion/runs/\(id)/pause")
    }

    func resumeRun(id: String) async throws -> [String: Any] {
        try await post("/api/companion/runs/\(id)/resume")
    }

    func cancelRun(id: String) async throws -> [String: Any] {
        try await post("/api/companion/runs/\(id)/cancel")
    }

    func getActivity() async throws -> [ActivityItem] {
        ActivityItem.list(from: try await awaitJSON(authedRequest(path: "/api/companion/activity")))
    }

    func getBriefing() async throws -> Briefing {
        Briefing.from(json: try await awaitJSON(authedRequest(path: "/api/companion/briefing")))
    }

    /// Bot roster for the chat picker (same shape as the web UI's
    /// GET /api/bots: a bare JSON array of bot configs). Lenient: a
    /// {"bots":[...]} envelope is accepted too, and bots without an id
    /// are skipped.
    func getBots() async throws -> [Bot] {
        let (data, response) = try await session.data(for: authedRequest(path: "/api/companion/bots"))
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, jsonObject(data).optString("error"))
        }
        let raw = try JSONSerialization.jsonObject(with: data)
        if let arr = raw as? [Any] { return Bot.list(fromArray: arr) }
        if let obj = raw as? [String: Any], let arr = obj["bots"] as? [Any] { return Bot.list(fromArray: arr) }
        return []
    }

    // MARK: - Remote screen (phone -> PC live screen view)
    // Approval-gated: start() returns a pending session; the PC owner
    // approves in the web UI, then the app opens the frame WebSocket.

    func startRemoteScreen() async throws -> RemoteScreenSession {
        let json = try await post("/api/remote-screen/start")
        guard json.optBool("ok", false) else {
            throw APIError.server(json.optString("detail", json.optString("error", "Failed to start screen sharing")))
        }
        return RemoteScreenSession.from(json: json)
    }

    func getRemoteScreenSession(sessionId: String) async throws -> RemoteScreenSession {
        let json = try await awaitJSON(authedRequest(path: "/api/remote-screen/session/\(sessionId)"))
        guard json.optBool("ok", false) else {
            throw APIError.server(json.optString("detail", json.optString("error", "Unknown screen session")))
        }
        guard let session = json["session"] as? [String: Any] else { throw APIError.invalidResponse }
        return RemoteScreenSession.from(json: session)
    }

    func stopRemoteScreen(sessionId: String) async -> Bool {
        do {
            let json = try await post("/api/remote-screen/stop", body: ["sessionId": sessionId])
            return json.optBool("ok", false)
        } catch {
            return false
        }
    }

    // MARK: - Chat (mirrors the web app's POST /api/chat)

    /// Sends one chat turn and streams the SSE events back as an
    /// AsyncStream.
    ///
    /// Mirrors apps/api POST /api/chat: body {botId, message, sessionId,
    /// queueMode}, response is `text/event-stream` with
    /// `data: {"type":"token","content":...}` events and a terminal
    /// `done`/`error`/`interrupted` event; `: ping` heartbeats are
    /// skipped. A non-SSE JSON reply (queueMode=queue while a turn is in
    /// flight) surfaces as ChatEvent.queued.
    ///
    /// The bot id comes from the chat picker selection persisted in
    /// PairingStore.selectedBotId. When no bot is selected the stream
    /// emits ChatEvent.error instead of sending, so the server never
    /// sees a placeholder id.
    func streamChat(message: String) -> AsyncStream<ChatEvent> {
        AsyncStream { continuation in
            let task = Task {
                guard let botId = store.selectedBotId, !botId.isEmpty else {
                    continuation.yield(.error("No bot selected — pick one from the chat screen."))
                    continuation.finish()
                    return
                }
                let body = jsonBody([
                    "botId": botId,
                    "message": message,
                    "sessionId": store.deviceId.isEmpty ? "companion" : store.deviceId,
                    "queueMode": "queue",
                ])
                let req = authedRequest(path: "/api/chat", method: "POST", body: body)
                do {
                    let (bytes, response) = try await session.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else {
                        continuation.yield(.error("Invalid chat response"))
                        continuation.finish()
                        return
                    }
                    let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
                    guard (200..<300).contains(http.statusCode) else {
                        var raw = Data()
                        for try await byte in bytes { raw.append(byte) }
                        continuation.yield(.error("HTTP \(http.statusCode): \(jsonObject(raw).optString("error"))"))
                        continuation.finish()
                        return
                    }
                    if !contentType.contains("text/event-stream") {
                        var raw = Data()
                        for try await byte in bytes { raw.append(byte) }
                        let json = jsonObject(raw)
                        if json.optBool("queued", false) {
                            continuation.yield(.queued(json.optInt("position", 0)))
                        } else {
                            continuation.yield(.error("Unexpected chat response"))
                        }
                        continuation.finish()
                        return
                    }
                    var full = ""
                    for try await line in bytes.lines {
                        let t = line.trimmingCharacters(in: .whitespaces)
                        if t.hasPrefix(":") { continue } // heartbeat comment
                        guard t.hasPrefix("data:") else { continue }
                        let payload = String(t.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces)
                        if payload == "[DONE]" { break }
                        guard let ev = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] else { continue }
                        switch ev.optString("type") {
                        case "token":
                            let c = ev.optString("content")
                            full += c
                            continuation.yield(.token(c))
                        case "done", "interrupted":
                            continuation.yield(.done(full))
                            continuation.finish()
                            return
                        case "error":
                            continuation.yield(.error(ev.optString("message", ev.optString("error", "Chat failed"))))
                            continuation.finish()
                            return
                        default:
                            continue
                        }
                    }
                    continuation.yield(.done(full))
                    continuation.finish()
                } catch {
                    continuation.yield(.error(error.localizedDescription))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
