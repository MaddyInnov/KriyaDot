// SPDX-License-Identifier: Apache-2.0
import Foundation
import Security

/// Minimal Keychain wrapper (Security framework, generic-password items).
/// The iOS counterpart of Android's EncryptedSharedPreferences storage:
/// pairing credentials never touch UserDefaults or files in plaintext.
final class KeychainStore {
    private let service: String

    init(service: String = "com.kriyadot.companion") {
        self.service = service
    }

    func string(forKey key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String?, forKey key: String) {
        let query = baseQuery(key)
        guard let value else {
            SecItemDelete(query as CFDictionary)
            return
        }
        let data = Data(value.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(item as CFDictionary, nil)
        }
    }

    func removeAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

/// Pairing storage: server address + long-lived device token in the
/// Keychain. The one-time token (ott) from the QR code is exchanged once
/// and never stored. Mirrors android-companion's PairingStore.kt.
final class PairingStore {
    private let keychain = KeychainStore()

    private enum Key {
        static let host = "host"
        static let port = "port"
        static let serverUrl = "server_url"
        static let deviceName = "device_name"
        static let deviceToken = "device_token"
        static let deviceId = "device_id"
        static let pushKey = "push_key"
        static let selectedBotId = "selected_bot_id"
    }

    var isPaired: Bool {
        !deviceToken.isEmpty && (!host.isEmpty || !(serverUrl ?? "").isEmpty)
    }

    var host: String { keychain.string(forKey: Key.host) ?? "" }
    var port: Int { Int(keychain.string(forKey: Key.port) ?? "") ?? 3000 }
    var deviceToken: String { keychain.string(forKey: Key.deviceToken) ?? "" }
    var deviceId: String { keychain.string(forKey: Key.deviceId) ?? "" }
    var deviceName: String { keychain.string(forKey: Key.deviceName) ?? "" }

    /// Per-device AES-256 key (base64) for sealed push payloads, issued at
    /// pairing. Nil for pairings made before push keys existed — pushes
    /// then fall back to generic text.
    var pushKey: String? {
        let v = keychain.string(forKey: Key.pushKey)
        return (v?.isEmpty == false) ? v : nil
    }

    /// Bot id chosen in the chat picker. Nil until the roster has loaded once.
    var selectedBotId: String? {
        get {
            let v = keychain.string(forKey: Key.selectedBotId)
            return (v?.isEmpty == false) ? v : nil
        }
        set { keychain.set(newValue, forKey: Key.selectedBotId) }
    }

    /// Hosted-mode public base URL (https://…), or nil for LAN pairing.
    var serverUrl: String? {
        let v = keychain.string(forKey: Key.serverUrl)
        return (v?.isEmpty == false) ? v : nil
    }

    /// Human label for the connection indicator: URL in hosted mode, host:port on LAN.
    var serverLabel: String { serverUrl ?? "\(host):\(port)" }

    /// http(s) base URL for REST calls.
    var baseUrl: String { serverUrl ?? "http://\(host):\(port)" }

    /// ws(s) base URL for the push socket — https upgrades to wss.
    var wsBaseUrl: String {
        let b = baseUrl
        if b.lowercased().hasPrefix("https://") {
            return "wss://" + String(b.dropFirst("https://".count))
        }
        if b.lowercased().hasPrefix("http://") {
            return "ws://" + String(b.dropFirst("http://".count))
        }
        return b
    }

    func save(host: String, port: Int, deviceName: String, result: PairingResult, serverUrl: String? = nil) {
        keychain.set(host, forKey: Key.host)
        keychain.set(String(port), forKey: Key.port)
        keychain.set(serverUrl ?? "", forKey: Key.serverUrl)
        keychain.set(deviceName, forKey: Key.deviceName)
        keychain.set(result.deviceToken, forKey: Key.deviceToken)
        keychain.set(result.deviceId, forKey: Key.deviceId)
        if !result.pushKey.isEmpty {
            keychain.set(result.pushKey, forKey: Key.pushKey)
        }
    }

    func saveSelectedBotId(_ id: String?) {
        selectedBotId = (id?.isEmpty == false) ? id : nil
    }

    func clear() {
        keychain.removeAll()
    }
}
