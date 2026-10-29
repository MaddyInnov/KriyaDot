// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Push channel for live updates from the KriyaDot instance:
///   ws://<host>:<port>/api/companion/ws?token=<deviceToken>
/// pushing {type:'run-status'|'approval'|'activity', ...}.
///
/// Per companion-PROTOCOL.md §5 the first client message must be
/// {t:'hello'} (the server answers {type:'hello', ok, snapshot}) and
/// {t:'ping'} is answered with {type:'pong'}.
///
/// Auto-reconnects with exponential backoff + jitter (1s -> 60s cap) and
/// reports coarse lifecycle events so the UI can show "live /
/// reconnecting".
///
/// Auth failures are NOT retried (mirrors Android's CompanionSocket M9
/// rule): when the server rejects the device token (WebSocket failure,
/// a 4401 close, or an in-band auth_failed error), reconnecting forever
/// would just hammer the server with a dead credential. Instead the
/// socket stops and reports onRePairRequired so the UI can prompt the
/// user to pair again.
final class CompanionSocket {
    protocol Listener: AnyObject {
        /// A push event arrived; payload is the raw JSON object.
        func companionSocket(didReceiveEvent type: String, payload: [String: Any])
        /// Connected (true) or (re)connecting (false).
        func companionSocket(didChangeConnection connected: Bool)
        /// The server rejected our device token; the socket has stopped.
        func companionSocketDidRequireRePair()
    }

    private let store: PairingStore
    private let session: URLSession
    private weak var listener: Listener?

    private let lock = NSLock()
    private var running = false
    private var authFailed = false
    private var attempts = 0
    private var task: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?

    /// True after an auth failure. The UI observes this (via
    /// Listener.companionSocket(onRePairRequired)) to show the
    /// "re-pair required" state. Cleared on the next start().
    private(set) var requiresRePair = false

    init(store: PairingStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
    }

    func start(listener: Listener) {
        lock.lock()
        if running { lock.unlock(); return }
        running = true
        authFailed = false
        requiresRePair = false
        attempts = 0
        self.listener = listener
        lock.unlock()
        connect()
    }

    func stop() {
        lock.lock()
        running = false
        authFailed = false
        requiresRePair = false
        listener = nil
        lock.unlock()
        reconnectTask?.cancel()
        receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return running && !authFailed
    }

    private func connect() {
        guard isRunning else { return }
        guard let url = URL(string: "\(store.wsBaseUrl)/api/companion/ws?token=\(store.deviceToken)") else { return }
        listener?.companionSocket(didChangeConnection: false)
        let ws = session.webSocketTask(with: url)
        task = ws
        ws.resume()
        // Protocol §5: announce before anything else.
        ws.send(.string(#"{"t":"hello"}"#)) { _ in }
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(ws)
        }
    }

    private func receiveLoop(_ ws: URLSessionWebSocketTask) async {
        while isRunning && task === ws {
            do {
                let message = try await ws.receive()
                switch message {
                case .string(let text):
                    handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { handleMessage(text) }
                @unknown default:
                    break
                }
            } catch {
                // URLSessionWebSocketTask does not expose the HTTP status
                // of a failed handshake; a close code surfaced via the
                // error is checked for 4401 (auth failed, phone-agent
                // contract), everything else reconnects.
                if (ws.closeCode.rawValue == 4401) {
                    onAuthFailed()
                } else {
                    scheduleReconnect()
                }
                return
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        let type = json.optString("type")
        if type.isEmpty { return }
        // In-band auth failure (mirrors Android): error + auth_failed.
        if type == "error" && json.optString("detail") == "auth_failed" {
            onAuthFailed()
            return
        }
        if type == "hello" {
            lock.lock(); attempts = 0; lock.unlock()
            listener?.companionSocket(didChangeConnection: true)
            return
        }
        if type == "ping" {
            task?.send(.string(#"{"t":"ping"}"#)) { _ in }
            return
        }
        if type == "pong" { return }
        listener?.companionSocket(didReceiveEvent: type, payload: json)
    }

    private func onAuthFailed() {
        lock.lock()
        if authFailed { lock.unlock(); return }
        authFailed = true
        requiresRePair = true
        lock.unlock()
        task?.cancel(with: .policyViolation, reason: nil)
        task = nil
        listener?.companionSocket(didChangeConnection: false)
        listener?.companionSocketDidRequireRePair()
    }

    private func scheduleReconnect() {
        guard isRunning else { return }
        listener?.companionSocket(didChangeConnection: false)
        lock.lock()
        let n = attempts
        attempts += 1
        lock.unlock()
        // 1s, 2s, 4s, ... capped at 60s, plus up to 500ms jitter.
        let delayMs = min(60_000, (1 << min(n, 10)) * 1000) + Int.random(in: 0..<500)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }
}
