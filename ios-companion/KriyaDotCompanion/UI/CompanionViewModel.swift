// SPDX-License-Identifier: Apache-2.0
import Foundation
import UIKit

/// Single source of truth for the companion app: pairing state, server
/// data, chat conversation, and the push socket. ObservableObject style
/// throughout the app. Mirrors android-companion's CompanionViewModel.kt.
@MainActor
final class CompanionViewModel: ObservableObject {
    let store = PairingStore()
    private lazy var api = KriyaDotAPI(store: store)
    private lazy var socket = CompanionSocket(store: store)
    private lazy var screenSocket = RemoteScreenSocket(store: store)

    @Published var paired: Bool
    @Published var pairingBusy = false
    @Published var pairingError: String?
    /// Scanned (or manually entered) payload awaiting user confirmation.
    @Published var pendingPairing: PairingPayload?

    @Published var status: ServerStatus?
    @Published var approvals: [Approval] = []
    @Published var runs: [RunSummary] = []
    @Published var activity: [ActivityItem] = []
    @Published var briefing: Briefing?
    @Published var loading = false
    @Published var socketLive = false
    /// True when the push socket stopped because the server rejected our
    /// device token. The UI shows a "re-pair required" prompt.
    @Published var rePairRequired = false
    @Published var error: String?

    @Published var messages: [ChatMessage] = []
    @Published var chatBusy = false
    private var chatTask: Task<Void, Never>?
    private var msgId: Int64 = 0

    @Published var bots: [Bot] = []
    @Published var selectedBotId: String?
    @Published var botsLoading = false

    /// Tab route requested by a push-notification tap ("approvals"/"chat").
    @Published var pushNavTarget: String?

    // Remote screen state.
    @Published var screenSession: RemoteScreenSession?
    @Published var screenImage: UIImage?
    /// Human-readable status line for the screen UI (approval wait, errors…).
    @Published var screenNote: String?
    private var screenPollTask: Task<Void, Never>?
    private var screenSocketConnected = false

    init() {
        paired = store.isPaired
        selectedBotId = store.selectedBotId
        // Push hooks: token deliveries and taps forward into this model.
        PushManager.shared.onToken = { [weak self] hex in
            Task { @MainActor in await self?.registerPushToken(hex) }
        }
        PushManager.shared.onNotificationTap = { [weak self] route in
            Task { @MainActor in self?.pushNavTarget = route }
        }
        if store.isPaired { startLive() }
    }

    // MARK: - Pairing

    func onQrScanned(_ payload: PairingPayload?) {
        pendingPairing = payload
        pairingError = payload == nil ? "That is not a KriyaDot pairing code." : nil
    }

    func clearPendingPairing() {
        pendingPairing = nil
        pairingError = nil
    }

    func confirmPairing(deviceName: String) {
        guard let p = pendingPairing else { return }
        let name = deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? "iPhone" : deviceName
        pairingBusy = true
        pairingError = nil
        Task {
            do {
                let result = try await api.exchangePairing(baseUrl: p.baseUrl, ott: p.ott, deviceName: name)
                store.save(host: p.host, port: p.port, deviceName: name, result: result, serverUrl: p.serverUrl)
                pendingPairing = nil
                paired = true
                startLive()
            } catch {
                pairingError = error.localizedDescription
            }
            pairingBusy = false
        }
    }

    func unpair() {
        socket.stop()
        stopScreenShare()
        store.clear()
        paired = false
        rePairRequired = false
        status = nil
        approvals = []
        runs = []
        activity = []
        briefing = nil
        messages = []
        bots = []
        selectedBotId = nil
    }

    // MARK: - Live data

    private func startLive() {
        refreshAll()
        PushManager.shared.requestAuthorizationAndRegister()
        socket.start(listener: SocketBridge(owner: self))
    }

    /// Bridges the socket's background callbacks onto the main actor.
    private final class SocketBridge: CompanionSocket.Listener {
        weak var owner: CompanionViewModel?
        init(owner: CompanionViewModel) { self.owner = owner }

        func companionSocket(didReceiveEvent type: String, payload: [String: Any]) {
            Task { @MainActor in
                guard let owner else { return }
                // Any push invalidates the affected list; simplest
                // correct strategy for MVP is to re-fetch the cheap
                // endpoints (same as Android).
                switch type {
                case "approval":
                    owner.refreshApprovals()
                case "run-status":
                    owner.refreshStatus()
                    owner.refreshRuns()
                case "activity":
                    owner.refreshActivity()
                default:
                    owner.refreshStatus()
                }
            }
        }

        func companionSocket(didChangeConnection connected: Bool) {
            Task { @MainActor in
                guard let owner else { return }
                owner.socketLive = connected
                if connected {
                    owner.rePairRequired = false
                    owner.refreshAll()
                }
            }
        }

        func companionSocketDidRequireRePair() {
            Task { @MainActor in self.owner?.rePairRequired = true }
        }
    }

    /// Registers this device's APNs token with the server so "done" /
    /// "needs you" pushes can arrive while the app is backgrounded.
    /// Best-effort, and server-side APNs sending is not implemented yet
    /// (see PushManager + README) — the WebSocket covers foreground.
    private func registerPushToken(_ hex: String) async {
        guard store.isPaired, !store.deviceId.isEmpty else { return }
        _ = await api.registerPushToken(hex)
    }

    func refreshAll() {
        refreshStatus()
        refreshApprovals()
        refreshRuns()
        refreshActivity()
        refreshBriefing()
        refreshBots()
    }

    func refreshStatus() { Task { await load { self.status = try await self.api.getStatus() } } }
    func refreshApprovals() { Task { await load { self.approvals = try await self.api.getApprovals() } } }
    func refreshRuns() { Task { await load { self.runs = try await self.api.getRuns() } } }
    func refreshActivity() { Task { await load { self.activity = try await self.api.getActivity() } } }
    func refreshBriefing() { Task { await load { self.briefing = try await self.api.getBriefing() } } }

    /// Loads the bot roster for the chat picker. Keeps the persisted
    /// selection when it is still on the roster; otherwise falls back
    /// to the first bot. An empty roster clears the selection.
    func refreshBots() {
        Task {
            botsLoading = true
            do {
                let list = try await api.getBots()
                bots = list
                let current = store.selectedBotId
                let resolved = list.contains { $0.id == current } ? current : list.first?.id
                selectedBotId = resolved
                store.saveSelectedBotId(resolved)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            botsLoading = false
        }
    }

    /// Ensures the roster is loaded once; later calls are no-ops while
    /// the cached list is non-empty.
    func ensureBots() {
        if !bots.isEmpty || botsLoading { return }
        refreshBots()
    }

    /// Persists an explicit chat bot-picker selection.
    func selectBot(id: String) {
        guard bots.contains(where: { $0.id == id }) else { return }
        selectedBotId = id
        store.saveSelectedBotId(id)
    }

    private func load(_ block: () async throws -> Void) async {
        loading = true
        do {
            try await block()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    func clearError() { error = nil }

    // MARK: - Approvals

    func decideApproval(id: String, approve: Bool, note: String?) {
        Task {
            loading = true
            do {
                if approve { _ = try await api.approve(id: id, note: note) }
                else { _ = try await api.deny(id: id, note: note) }
                approvals = try await api.getApprovals()
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }

    // MARK: - Runs

    func runAction(id: String, action: String) {
        Task {
            loading = true
            do {
                switch action {
                case "pause": _ = try await api.pauseRun(id: id)
                case "resume": _ = try await api.resumeRun(id: id)
                case "cancel": _ = try await api.cancelRun(id: id)
                default: break
                }
                runs = try await api.getRuns()
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        }
    }

    // MARK: - Chat

    func sendChat(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || chatBusy { return }
        if (selectedBotId ?? "").isEmpty {
            error = bots.isEmpty ? "No bots available." : "Pick a bot before sending."
            return
        }
        chatTask?.cancel()
        msgId += 1
        messages.append(ChatMessage(id: msgId, role: "user", text: trimmed))
        msgId += 1
        let assistantId = msgId
        messages.append(ChatMessage(id: assistantId, role: "assistant", text: ""))
        chatBusy = true
        chatTask = Task {
            var acc = ""
            for await event in api.streamChat(message: trimmed) {
                switch event {
                case .token(let t):
                    acc += t
                    appendAssistant(id: assistantId, text: acc)
                case .done(let fullText):
                    appendAssistant(id: assistantId, text: fullText.isEmpty ? acc : fullText)
                    chatBusy = false
                case .queued(let position):
                    appendAssistant(id: assistantId, text: "(queued at position \(position))")
                case .error(let message):
                    appendAssistant(id: assistantId, text: "Error: \(message)")
                    chatBusy = false
                }
            }
            if chatBusy { chatBusy = false }
        }
    }

    private func appendAssistant(id: Int64, text: String) {
        guard let idx = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[idx].text = text
    }

    func clearChat() { messages = [] }

    // MARK: - Remote screen (phone -> PC live view)

    /// Ask the PC to share its screen. The owner must approve in the web UI.
    func startScreenShare() {
        if screenSession != nil { return }
        screenNote = nil
        screenImage = nil
        Task {
            do {
                let s = try await api.startRemoteScreen()
                screenSession = s
                screenNote = "Waiting for approval on your PC…"
                pollScreenSession(first: s)
            } catch {
                self.error = "Couldn't start screen sharing: \(error.localizedDescription)"
            }
        }
    }

    private func pollScreenSession(first: RemoteScreenSession) {
        screenPollTask?.cancel()
        screenPollTask = Task {
            var session = first
            while !Task.isCancelled {
                let delay = min(max(session.pollMs, 1000), 10_000)
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
                if Task.isCancelled { return }
                do {
                    session = try await api.getRemoteScreenSession(sessionId: session.sessionId)
                } catch {
                    screenNote = "Lost contact with the PC: \(error.localizedDescription)"
                    return
                }
                screenSession = session
                if session.isLive {
                    screenNote = session.mock ? "Preview mode (test feed)" : "Live"
                    connectScreenSocket(sessionId: session.sessionId)
                    return
                }
                if session.isTerminal {
                    screenNote = session.status == "denied"
                        ? "Screen sharing was declined on the PC."
                        : session.status == "expired"
                            ? "The approval request expired."
                            : "Screen sharing ended."
                    screenSession = nil
                    return
                }
                screenNote = "Waiting for approval on your PC…"
            }
        }
    }

    private func connectScreenSocket(sessionId: String) {
        if screenSocketConnected { return }
        screenSocketConnected = true
        screenSocket.start(sessionId: sessionId, listener: ScreenBridge(owner: self))
    }

    private final class ScreenBridge: RemoteScreenSocket.Listener {
        weak var owner: CompanionViewModel?
        init(owner: CompanionViewModel) { self.owner = owner }

        func remoteScreen(onConnected mock: Bool) {
            Task { @MainActor in
                self.owner?.screenNote = mock ? "Preview mode (test feed)" : "Live"
            }
        }

        func remoteScreen(onFrame image: UIImage, w: Int, h: Int, frameNo: Int64) {
            Task { @MainActor in self.owner?.screenImage = image }
        }

        func remoteScreen(onServerError detail: String) {
            Task { @MainActor in
                self.owner?.screenNote = detail == "capture_failed"
                    ? "The PC couldn't capture its screen."
                    : detail == "not_approved"
                        ? "Not approved on the PC."
                        : "Screen error: \(detail)"
            }
        }

        func remoteScreen(onEnded reason: String) {
            Task { @MainActor in
                guard let owner else { return }
                owner.screenNote = reason == "max_duration"
                    ? "Screen sharing stopped (30-minute limit)."
                    : reason == "capture_unavailable"
                        ? "Screen capture unavailable on the PC."
                        : "Screen sharing ended."
                owner.screenSession = nil
                owner.screenImage = nil
                owner.screenSocketConnected = false
            }
        }

        func remoteScreen(onConnectionLost willRetry: Bool) {
            Task { @MainActor in
                guard let owner else { return }
                owner.screenNote = "Connection to the PC lost."
                owner.screenSession = nil
                owner.screenImage = nil
                owner.screenSocketConnected = false
            }
        }
    }

    /// Stop sharing (also tells the PC to end the session).
    func stopScreenShare() {
        screenPollTask?.cancel()
        screenPollTask = nil
        screenSocket.stop()
        screenSocketConnected = false
        let id = screenSession?.sessionId
        screenSession = nil
        screenImage = nil
        screenNote = nil
        if let id {
            Task { _ = await api.stopRemoteScreen(sessionId: id) }
        }
    }
}
