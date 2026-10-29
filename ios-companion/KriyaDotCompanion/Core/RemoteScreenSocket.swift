// SPDX-License-Identifier: Apache-2.0
import Foundation
import UIKit

/// Live screen frame channel from the KriyaDot PC.
///
///   ws(s)://<host>:<port>/api/remote-screen/ws?sessionId=<id>&token=<deviceToken>
///
/// Server messages (JSON text):
///   {t:'ok', sessionId, mock}            — handshake accepted
///   {t:'frame', png, w, h, ts, n, mock}  — one screen frame (base64 PNG/JPEG)
///   {t:'error', detail}                  — capture_failed | not_approved | ...
///   {t:'ended', reason}                  — session over (owner stopped, denied,
///                                          30-min cap, capture unavailable)
///
/// The channel is view-only: anything the client sends gets a
/// {t:'error', detail:'view_only'} reply and is ignored.
///
/// Frames are decoded to UIImage off the main thread and delivered via
/// Listener callbacks, which the view model hops to the main actor for
/// UI work. Mirrors android-companion's RemoteScreenSocket.kt.
final class RemoteScreenSocket {
    protocol Listener: AnyObject {
        func remoteScreen(onConnected mock: Bool)
        func remoteScreen(onFrame image: UIImage, w: Int, h: Int, frameNo: Int64)
        func remoteScreen(onServerError detail: String)
        func remoteScreen(onEnded reason: String)
        func remoteScreen(onConnectionLost willRetry: Bool)
    }

    private let store: PairingStore
    private let session: URLSession
    private weak var listener: Listener?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var closed = false

    init(store: PairingStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
    }

    /// Open the frame channel for an approved session.
    func start(sessionId: String, listener: Listener) {
        stop()
        closed = false
        self.listener = listener
        let urlString = "\(store.wsBaseUrl)/api/remote-screen/ws?sessionId=\(sessionId)&token=\(store.deviceToken)"
        guard let url = URL(string: urlString) else { return }
        let ws = session.webSocketTask(with: url)
        task = ws
        ws.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(ws)
        }
    }

    func stop() {
        closed = true
        listener = nil
        receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func receiveLoop(_ ws: URLSessionWebSocketTask) async {
        while !closed && task === ws {
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
                if !closed { listener?.remoteScreen(onConnectionLost: false) }
                return
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let listener,
              let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        switch o.optString("t") {
        case "ok":
            listener.remoteScreen(onConnected: o.optBool("mock", false))
        case "frame":
            guard let data = Data(base64Encoded: o.optString("png", "")), !data.isEmpty,
                  let image = UIImage(data: data) else { return }
            listener.remoteScreen(
                onFrame: image,
                w: o.optInt("w", Int(image.size.width)),
                h: o.optInt("h", Int(image.size.height)),
                frameNo: Int64(o.optInt("n", 0))
            )
        case "error":
            listener.remoteScreen(onServerError: o.optString("detail", "unknown"))
        case "ended":
            listener.remoteScreen(onEnded: o.optString("reason", "ended"))
            stop()
        default:
            break
        }
    }
}
