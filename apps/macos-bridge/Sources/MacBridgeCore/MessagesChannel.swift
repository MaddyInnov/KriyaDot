// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Messages (iMessage / SMS relay) channel backed by AppleScript
/// (Wave-6, DV-8).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED without Apple hardware. ***
/// The scripts below follow the documented Messages scripting
/// dictionary (chats, participants, messages, send). They have never
/// been executed: no Mac exists on the build VM. Expect to shake out
/// scripting-dictionary quirks on first real run — the JSON shaping
/// (parse + record building) is isolated from the scripts so it can
/// be corrected without touching the transport.
///
/// Output rows use the Android-identical shape:
/// { address, body, date, type } with type 1 = received, 2 = sent.
public final class MessagesChannel: MessageChannel {
    private let runner: AppleScriptRunning

    public init(runner: AppleScriptRunning = OsascriptRunner()) {
        self.runner = runner
    }

    /// Escape a Swift string for embedding in an AppleScript string literal.
    private func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }

    /// Shared script fragment: flatten a message into
    /// address RS body RS epochSeconds RS direction lines.
    private let flattenFragment = """
        set epochRef to date "Monday, January 1, 2001 00:00:00"
        """

    public func recentMessages(limit: Int) throws -> [[String: Any]] {
        let n = min(max(limit, 1), 200)
        let script = """
            \(flattenFragment)
            set rs to (ASCII character 30)
            set outLines to {}
            tell application "Messages"
                repeat with c in chats
                    set handle to ""
                    try
                        set handle to id of first participant of c
                    end try
                    set msgs to messages of c
                    set startIdx to (count of msgs) - \(n) + 1
                    if startIdx < 1 then set startIdx to 1
                    repeat with i from startIdx to (count of msgs)
                        set m to item i of msgs
                        set bodyText to ""
                        try
                            set bodyText to text of m
                        end try
                        if length of bodyText > 1000 then set bodyText to text 1 thru 1000 of bodyText
                        set dirFlag to "1"
                        try
                            if direction of m is outgoing then set dirFlag to "2"
                        end try
                        set secs to ((date of m) - epochRef) as integer
                        set end of outLines to (handle & rs & bodyText & rs & secs & rs & dirFlag)
                    end repeat
                end repeat
            end tell
            set AppleScript's text item delimiters to linefeed
            return outLines as text
            """
        return try shape(try runner.run(script))
    }

    public func thread(address: String, limit: Int) throws -> [[String: Any]] {
        let n = min(max(limit, 1), 200)
        let script = """
            \(flattenFragment)
            set rs to (ASCII character 30)
            set outLines to {}
            tell application "Messages"
                repeat with c in chats
                    set handle to ""
                    try
                        set handle to id of first participant of c
                    end try
                    if handle is "\(esc(address))" then
                        set msgs to messages of c
                        set startIdx to (count of msgs) - \(n) + 1
                        if startIdx < 1 then set startIdx to 1
                        repeat with i from startIdx to (count of msgs)
                            set m to item i of msgs
                            set bodyText to ""
                            try
                                set bodyText to text of m
                            end try
                            if length of bodyText > 1000 then set bodyText to text 1 thru 1000 of bodyText
                            set dirFlag to "1"
                            try
                                if direction of m is outgoing then set dirFlag to "2"
                            end try
                            set secs to ((date of m) - epochRef) as integer
                            set end of outLines to (handle & rs & bodyText & rs & secs & rs & dirFlag)
                        end repeat
                    end if
                end repeat
            end tell
            set AppleScript's text item delimiters to linefeed
            return outLines as text
            """
        return try shape(try runner.run(script))
    }

    public func send(address: String, body: String) throws {
        guard !address.isEmpty, !body.isEmpty else { throw BridgeError("invalid_send") }
        let script = """
            tell application "Messages"
                set targetService to 1st service whose service type = iMessage
                set targetBuddy to participant "\(esc(address))" of targetService
                send "\(esc(body))" to targetBuddy
            end tell
            """
        _ = try runner.run(script)
    }

    private func shape(_ raw: String) throws -> [[String: Any]] {
        let rows = parseSeparatedRecords(raw).compactMap { fields -> [String: Any]? in
            guard fields.count >= 4 else { return nil }
            return [
                "address": fields[0],
                "body": fields[1],
                "date": epochMsFromAppleScriptSeconds(fields[2]),
                "type": Int(fields[3]) ?? 1,
            ]
        }
        return rows.sorted { (($0["date"] as? Int) ?? 0) > (($1["date"] as? Int) ?? 0) }
    }
}
