// SPDX-License-Identifier: Apache-2.0
import Foundation
import MacBridgeCore

/// KriyaDot macOS bridge executable (Wave-6, DV-8) — skeleton.
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED without Apple hardware. ***
///
/// Transport: newline-delimited JSON on stdin/stdout, the same
/// request/response discipline as the phone hub's data_query frames,
/// so the API-side adapter (future wiring — see the wave-6 wiring
/// note) is a small local-process client:
///
///   in : {"id":"1","channel":"messages","op":"recent","params":{"limit":20}}
///        {"id":"2","channel":"mail","op":"recent","params":{"mailbox":"inbox","limit":20}}
///        {"id":"3","channel":"messages","op":"send","params":{"address":"+1…","body":"…"}}
///   out: {"id":"1","ok":true,"data":{"messages":[…]}}
///        {"id":"3","ok":false,"error":"automation_not_granted"}
///
/// Sends arrive here ONLY after the API's governance approval — the
/// bridge itself holds no approval logic and must never be exposed
/// on a network port; it speaks to its parent process over pipes.
let messages: MessageChannel = MessagesChannel()
let mail: MailChannel = AppleScriptMailChannel()

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func handle(_ request: [String: Any]) -> [String: Any] {
    let id = request["id"] as? String ?? ""
    let channel = request["channel"] as? String ?? ""
    let op = request["op"] as? String ?? ""
    let params = request["params"] as? [String: Any] ?? [:]
    do {
        switch (channel, op) {
        case ("messages", "recent"):
            let limit = params["limit"] as? Int ?? 20
            return ["id": id, "ok": true, "data": ["messages": try messages.recentMessages(limit: limit)]]
        case ("messages", "thread"):
            let limit = params["limit"] as? Int ?? 50
            let address = params["address"] as? String ?? ""
            return ["id": id, "ok": true, "data": ["messages": try messages.thread(address: address, limit: limit), "address": address]]
        case ("messages", "send"):
            try messages.send(address: params["address"] as? String ?? "", body: params["body"] as? String ?? "")
            return ["id": id, "ok": true, "data": [:]]
        case ("mail", "recent"):
            let limit = params["limit"] as? Int ?? 20
            let mailbox = params["mailbox"] as? String ?? "inbox"
            return ["id": id, "ok": true, "data": ["messages": try mail.recentMessages(mailbox: mailbox, limit: limit)]]
        case ("mail", "body"):
            return ["id": id, "ok": true, "data": try mail.messageBody(id: params["id"] as? String ?? "")]
        case ("mail", "send"):
            try mail.send(
                to: params["to"] as? String ?? "",
                subject: params["subject"] as? String ?? "",
                body: params["body"] as? String ?? ""
            )
            return ["id": id, "ok": true, "data": [:]]
        default:
            return ["id": id, "ok": false, "error": "unknown_op"]
        }
    } catch let error as BridgeError {
        return ["id": id, "ok": false, "error": error.code]
    } catch {
        return ["id": id, "ok": false, "error": "bridge_failed"]
    }
}

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(["id": "", "ok": false, "error": "invalid_json"])
        continue
    }
    emit(handle(request))
}
