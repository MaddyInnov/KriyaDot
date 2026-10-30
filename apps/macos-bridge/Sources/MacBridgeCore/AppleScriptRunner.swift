// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Runs AppleScript against the user's own Messages / Mail apps via
/// /usr/bin/osascript (Wave-6, DV-8).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED without Apple hardware. ***
///
/// Why AppleScript and not the chat.db / Mail data files: Messages'
/// chat.db is Full-Disk-Access gated and its schema is private and
/// unstable; scripting the apps the user is signed into is the
/// supported automation surface, gated by macOS Automation consent
/// (the user approves "KriyaDot Mac Bridge may control Messages/Mail"
/// in System Settings). If consent is missing, osascript fails and
/// the failure maps to BridgeError("automation_not_granted").
///
/// The runner is a protocol so the JSON shaping in the channels can
/// be unit-tested on a Mac with a fake runner — no live apps needed.
public protocol AppleScriptRunning {
    /// Execute a script, returning stdout. Throws BridgeError on failure.
    func run(_ source: String) throws -> String
}

public final class OsascriptRunner: AppleScriptRunning {
    public init() {}

    public func run(_ source: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
        } catch {
            throw BridgeError("osascript_unavailable")
        }
        process.waitUntilExit()
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            // -1743 is the classic "not authorized to send Apple events" code.
            if errText.contains("-1743") || errText.lowercased().contains("not authorized") {
                throw BridgeError("automation_not_granted")
            }
            throw BridgeError("applescript_failed")
        }
        return out
    }
}

/// Parse the channels' wire convention: one record per line, fields
/// separated by U+001E (record separator) so message bodies containing
/// commas/newlines (pre-flattened by the scripts) cannot corrupt the
/// framing. Empty trailing line is dropped.
public func parseSeparatedRecords(_ raw: String) -> [[String]] {
    raw.split(separator: "\n", omittingEmptySubsequences: true).map { line in
        line.split(separator: "\u{1E}", omittingEmptySubsequences: false).map(String.init)
    }
}

/// Epoch-ms from an AppleScript "date" string the scripts emit as
/// seconds since 2001-01-01 (AppleScript's native epoch) — the
/// scripts convert with `... as integer` offsets; see the channel
/// implementations. Kept here so every channel converts identically.
public func epochMsFromAppleScriptSeconds(_ text: String) -> Int {
    let seconds = Double(text.trimmingCharacters(in: .whitespaces)) ?? 0
    // AppleScript epoch (2001-01-01 UTC) in Unix seconds.
    let appleEpochOffset = 978_307_200.0
    return Int((seconds + appleEpochOffset) * 1000)
}
