// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Apple Mail channel backed by AppleScript (Wave-6, DV-8).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED without Apple hardware. ***
/// Written against the documented Mail scripting dictionary
/// (mailboxes, messages, sender/subject/date received/read status,
/// outgoing messages). Never executed — no Mac on the build VM.
///
/// Row shape: { id, mailbox, sender, subject, date, snippet, unread }
/// with date = epoch ms, matching the API's lenient channel style.
public final class AppleScriptMailChannel: MailChannel {
    private let runner: AppleScriptRunning

    public init(runner: AppleScriptRunning = OsascriptRunner()) {
        self.runner = runner
    }

    private func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }

    public func recentMessages(mailbox: String, limit: Int) throws -> [[String: Any]] {
        let n = min(max(limit, 1), 200)
        let box = mailbox.isEmpty ? "inbox" : mailbox
        let script = """
            set epochRef to date "Monday, January 1, 2001 00:00:00"
            set rs to (ASCII character 30)
            set outLines to {}
            tell application "Mail"
                set msgs to messages 1 thru \(n) of mailbox "\(esc(box))"
                repeat with m in msgs
                    set secs to ((date received of m) - epochRef) as integer
                    set snip to ""
                    try
                        set snip to content of m
                        if length of snip > 200 then set snip to text 1 thru 200 of snip
                    end try
                    set unreadFlag to "0"
                    if read status of m is false then set unreadFlag to "1"
                    set end of outLines to ((id of m as text) & rs & "\(esc(box))" & rs & (sender of m) & rs & (subject of m) & rs & secs & rs & snip & rs & unreadFlag)
                end repeat
            end tell
            set AppleScript's text item delimiters to linefeed
            return outLines as text
            """
        return parseSeparatedRecords(try runner.run(script)).compactMap { fields in
            guard fields.count >= 7 else { return nil }
            return [
                "id": fields[0],
                "mailbox": fields[1],
                "sender": fields[2],
                "subject": fields[3],
                "date": epochMsFromAppleScriptSeconds(fields[4]),
                "snippet": fields[5],
                "unread": fields[6] == "1",
            ]
        }
    }

    public func messageBody(id: String) throws -> [String: Any] {
        guard let numericId = Int(id) else { throw BridgeError("invalid_message_id") }
        let script = """
            tell application "Mail"
                set m to first message whose id is \(numericId)
                return content of m
            end tell
            """
        return ["id": id, "body": try runner.run(script)]
    }

    public func send(to: String, subject: String, body: String) throws {
        guard !to.isEmpty else { throw BridgeError("invalid_send") }
        let script = """
            tell application "Mail"
                set newMessage to make new outgoing message with properties {subject:"\(esc(subject))", content:"\(esc(body))", visible:false}
                tell newMessage
                    make new to recipient at end of to recipients with properties {address:"\(esc(to))"}
                end tell
                send newMessage
            end tell
            """
        _ = try runner.run(script)
    }
}
