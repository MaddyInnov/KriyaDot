// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Parses the pairing QR payload shown by KriyaDot Workspace -> Devices.
/// Two flavors:
/// - LAN:    kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>
/// - Hosted: kriyadot://pair?url=https://kriyadot.example.com&token=<ott>
///
/// Returns nil for anything that is not a well-formed pairing payload, so
/// the scanner UI can show "not a KriyaDot pairing code" instead of
/// failing later. Mirrors android-companion's QrParser.kt exactly.
enum QrParser {
    static func parse(_ raw: String?) -> PairingPayload? {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "kriyadot",
              components.host == "pair" else { return nil }
        let query = Dictionary(
            (components.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { first, _ in first }
        )
        let ott = (query["token"] ?? "").trimmingCharacters(in: .whitespaces)
        if ott.isEmpty { return nil }
        let url = (query["url"] ?? "").trimmingCharacters(in: .whitespaces)
        if !url.isEmpty {
            guard let normalized = normalizeServerUrl(url) else { return nil }
            return PairingPayload(host: "", port: 0, ott: ott, serverUrl: normalized)
        }
        let host = (query["host"] ?? "").trimmingCharacters(in: .whitespaces)
        guard let port = Int(query["port"] ?? ""), !host.isEmpty, (1...65535).contains(port) else {
            return nil
        }
        return PairingPayload(host: host, port: port, ott: ott, serverUrl: nil)
    }

    /// Normalizes a manually entered or QR-provided server URL: trims
    /// whitespace/trailing slashes, requires an http(s) scheme and a
    /// non-empty host. Returns nil when the URL is not usable.
    static func normalizeServerUrl(_ raw: String?) -> String? {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while v.hasSuffix("/") { v.removeLast() }
        if v.isEmpty { return nil }
        let lower = v.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
        let afterScheme = v.components(separatedBy: "://").dropFirst().joined(separator: "://")
        if afterScheme.isEmpty || afterScheme.hasPrefix("/") { return nil }
        if afterScheme.contains(" ") || afterScheme.contains("\t") { return nil }
        return v
    }
}
