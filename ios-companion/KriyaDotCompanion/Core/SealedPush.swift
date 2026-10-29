// SPDX-License-Identifier: Apache-2.0
import CryptoKit
import Foundation

/// Decrypts sealed push payloads.
///
/// The server seals {title, body} with AES-256-GCM under the per-device
/// push key established at pairing; the push transport (FCM today, APNs
/// once the server supports it) only ever carries the ciphertext. This
/// runs locally on the phone. Mirrors apps/api/src/push.ts sealPayload
/// and android-companion's SealedPush.kt.
enum SealedPush {
    struct Content {
        let title: String
        let body: String
    }

    /// - Parameters:
    ///   - sealedB64: base64url of {"v":1,"nonce":"<b64>","ct":"<b64>"}
    ///     where ct is ciphertext with the 16-byte GCM tag appended.
    ///   - pushKeyB64: base64 of the 32-byte device push key.
    /// - Returns: decrypted content, or nil when the key is missing or
    ///   invalid or the payload fails authentication (caller shows the
    ///   generic fallback text).
    static func open(sealedB64: String?, pushKeyB64: String?) -> Content? {
        guard let sealedB64, !sealedB64.isEmpty,
              let pushKeyB64, !pushKeyB64.isEmpty,
              let keyData = Data(base64Encoded: pushKeyB64), keyData.count == 32,
              let sealedData = Data(base64UrlEncoded: sealedB64),
              let sealed = (try? JSONSerialization.jsonObject(with: sealedData)) as? [String: Any],
              sealed.optInt("v", -1) == 1,
              let nonceB64 = sealed["nonce"] as? String,
              let nonceData = Data(base64Encoded: nonceB64),
              let nonce = try? AES.GCM.Nonce(data: nonceData),
              let ctB64 = sealed["ct"] as? String,
              let raw = Data(base64Encoded: ctB64), raw.count > 16
        else { return nil }
        // Server layout: ciphertext || 16-byte auth tag.
        let ciphertext = raw.dropLast(16)
        let tag = raw.suffix(16)
        guard let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: keyData)),
              let o = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
        else { return nil }
        let content = Content(
            title: String(o.optString("title").prefix(80)),
            body: String(o.optString("body").prefix(400))
        )
        return (content.title.isEmpty && content.body.isEmpty) ? nil : content
    }
}

extension Data {
    /// Decodes base64url (RFC 4648 §5) input, tolerating missing padding.
    init?(base64UrlEncoded string: String) {
        var s = string.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }
}
