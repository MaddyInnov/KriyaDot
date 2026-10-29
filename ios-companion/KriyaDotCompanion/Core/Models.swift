// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Lenient model parsing for the companion contract.
///
/// Mirrors android-companion's Models.kt field-for-field: the server
/// contract uses the same JSON shapes on both platforms, and every field
/// is read with opt*-style accessors so unknown or missing fields degrade
/// to defaults instead of failing the decode.

// MARK: - Lenient JSON helpers (mirror org.json opt* semantics)

extension Dictionary where Key == String, Value == Any {
    func optString(_ key: String, _ fallback: String = "") -> String {
        if let s = self[key] as? String { return s }
        if let n = self[key] as? NSNumber { return n.stringValue }
        return fallback
    }

    func optString(_ key: String, _ alternate: String, _ fallback: String = "") -> String {
        let v = optString(key)
        return v.isEmpty ? optString(alternate, fallback) : v
    }

    func optInt(_ key: String, _ fallback: Int = 0) -> Int {
        if let n = self[key] as? NSNumber { return n.intValue }
        if let s = self[key] as? String, let v = Int(s) { return v }
        return fallback
    }

    func optInt(_ key: String, _ alternate: String, _ fallback: Int = 0) -> Int {
        if self[key] != nil { return optInt(key, fallback) }
        return optInt(alternate, fallback)
    }

    func optBool(_ key: String, _ fallback: Bool = false) -> Bool {
        if let b = self[key] as? Bool { return b }
        if let n = self[key] as? NSNumber { return n.boolValue }
        return fallback
    }

    func optDict(_ key: String) -> [String: Any]? {
        self[key] as? [String: Any]
    }

    func optArray(_ key: String) -> [[String: Any]]? {
        (self[key] as? [Any])?.compactMap { $0 as? [String: Any] }
    }

    func optArray(_ key: String, _ alternate: String) -> [[String: Any]]? {
        optArray(key) ?? optArray(alternate)
    }
}

func jsonObject(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

func jsonBody(_ object: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
}

// MARK: - Pairing

/// Parsed from the pairing QR payload. Two flavors:
/// - LAN:    kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>
/// - Hosted: kriyadot://pair?url=https://kriyadot.example.com&token=<ott>
struct PairingPayload: Equatable {
    let host: String
    let port: Int
    let ott: String
    let serverUrl: String?

    var isHosted: Bool { !(serverUrl ?? "").isEmpty }

    /// Human label for confirm dialogs and the connection indicator.
    var serverLabel: String { serverUrl ?? "\(host):\(port)" }

    /// http(s) base URL for REST calls.
    var baseUrl: String { serverUrl ?? "http://\(host):\(port)" }
}

struct PairingResult {
    let deviceToken: String
    let deviceId: String
    /// base64 AES-256 key for sealed pushes; empty when the server predates push keys.
    let pushKey: String
}

// MARK: - Server data

struct ServerStatus {
    let healthy: Bool
    let serverName: String
    let version: String
    let activeRuns: Int
    let pendingApprovals: Int

    static func from(json o: [String: Any]) -> ServerStatus {
        let runs = o.optArray("runs") ?? o.optArray("activeRuns")
        let server = o.optDict("server")
        return ServerStatus(
            healthy: o.optBool("ok", true) && o.optBool("healthy", true),
            serverName: server?.optString("name", "KriyaDot") ?? o.optString("serverName", "KriyaDot"),
            version: server?.optString("version", "") ?? o.optString("version", ""),
            activeRuns: runs?.count ?? o.optInt("activeRuns", "runCount", 0),
            pendingApprovals: o.optInt("pendingApprovals", "pendingApprovalCount", 0)
        )
    }
}

struct Approval: Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let sessionId: String
    let createdAt: String

    static func list(from json: [String: Any]) -> [Approval] {
        guard let arr = json.optArray("approvals", "items") else { return [] }
        return arr.compactMap { a in
            let item = Approval(
                id: a.optString("id"),
                title: a.optString("title", a.optString("kind", "Approval requested")),
                detail: a.optString("detail", a.optString("description", a.optString("prompt", ""))),
                sessionId: a.optString("sessionId", ""),
                createdAt: a.optString("createdAt", a.optString("ts", ""))
            )
            return item.id.isEmpty ? nil : item
        }
    }
}

struct RunSummary: Identifiable, Equatable {
    let id: String
    let label: String
    let state: String // running | paused | queued | ...
    let detail: String

    static func list(from json: [String: Any]) -> [RunSummary] {
        guard let arr = json.optArray("runs", "items") else { return [] }
        return arr.compactMap { r in
            let item = RunSummary(
                id: r.optString("id"),
                label: r.optString("label", r.optString("title", r.optString("botId", "Run"))),
                state: r.optString("state", r.optString("status", "unknown")),
                detail: r.optString("detail", r.optString("summary", ""))
            )
            return item.id.isEmpty ? nil : item
        }
    }
}

struct ActivityItem: Identifiable, Equatable {
    let id: String
    let text: String
    let kind: String
    let createdAt: String

    static func list(from json: [String: Any]) -> [ActivityItem] {
        guard let arr = json.optArray("activity", "items") else { return [] }
        return arr.enumerated().compactMap { i, a in
            let item = ActivityItem(
                id: a.optString("id", "\(i)"),
                text: a.optString("text", a.optString("message", a.optString("summary", ""))),
                kind: a.optString("kind", a.optString("type", "")),
                createdAt: a.optString("createdAt", a.optString("ts", ""))
            )
            return item.text.isEmpty ? nil : item
        }
    }
}

struct Briefing {
    let title: String
    let body: String
    let generatedAt: String

    static func from(json o: [String: Any]) -> Briefing {
        Briefing(
            title: o.optString("title", "Daily briefing"),
            body: o.optString("body", o.optString("text", o.optString("summary", ""))),
            generatedAt: o.optString("generatedAt", o.optString("ts", ""))
        )
    }
}

/// A chat bot from GET /api/companion/bots (same shape as the web UI's
/// GET /api/bots: bot config fields plus workspacePath).
struct Bot: Identifiable, Equatable {
    let id: String
    let name: String

    static func list(fromArray arr: [Any]) -> [Bot] {
        arr.compactMap { raw in
            guard let b = raw as? [String: Any] else { return nil }
            let id = b.optString("id")
            if id.isEmpty { return nil }
            return Bot(id: id, name: b.optString("name", id))
        }
    }
}

/// One chat message in the conversation view.
struct ChatMessage: Identifiable, Equatable {
    let id: Int64
    let role: String // "user" | "assistant" | "system"
    var text: String
}

/// Streaming events from POST /api/chat (SSE). Mirrors Android's ChatEvent.
enum ChatEvent {
    case token(String)
    case done(String)
    /// Server queued the message because a turn is already in flight.
    case queued(Int)
    case error(String)
}

/// A remote-screen session (phone viewing the PC's live screen).
struct RemoteScreenSession {
    let sessionId: String
    let status: String // pending | approved | active | denied | expired | ended
    let deviceName: String
    let wsPath: String
    let pollMs: Int64
    let mock: Bool

    init(sessionId: String, status: String, deviceName: String = "",
         wsPath: String = "/api/remote-screen/ws", pollMs: Int64 = 2000, mock: Bool = false) {
        self.sessionId = sessionId
        self.status = status
        self.deviceName = deviceName
        self.wsPath = wsPath
        self.pollMs = pollMs
        self.mock = mock
    }

    static func from(json o: [String: Any]) -> RemoteScreenSession {
        let s = o["session"] as? [String: Any] ?? o
        return RemoteScreenSession(
            sessionId: s.optString("sessionId", o.optString("sessionId", "")),
            status: s.optString("status", "pending"),
            deviceName: s.optString("deviceName", ""),
            wsPath: o.optString("wsPath", "/api/remote-screen/ws"),
            pollMs: Int64(o.optInt("pollMs", 2000)),
            mock: s.optBool("mock", false)
        )
    }

    var isTerminal: Bool { status == "denied" || status == "expired" || status == "ended" }
    var isLive: Bool { status == "approved" || status == "active" }
}
