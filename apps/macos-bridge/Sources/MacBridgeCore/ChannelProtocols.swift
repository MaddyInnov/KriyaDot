// SPDX-License-Identifier: Apache-2.0
import Foundation

/// Channel interfaces for the macOS bridge (Wave-6, DV-8).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED without Apple hardware ***
/// (see Package.swift).
///
/// These protocols are the macOS counterpart of the Android
/// phone-agent's data-query surface: the SAME shapes the KriyaDot API
/// already exchanges with the phone hub (apps/api/src/phone.ts
/// data_query / data_result), so the server can treat a Mac exactly
/// like a paired phone for these two channels:
///
///   messages -> { messages: [ { address, body, date, type } ] }
///     (identical keys to PhoneDataHandlers' messages/sms_thread:
///      address = the other party, body capped at 1000 chars,
///      date = epoch ms, type 1 = received / 2 = sent)
///   mail     -> { messages: [ { id, mailbox, sender, subject, date,
///                               snippet, unread } ] }
///
/// Shapes are plain [String: Any] dictionaries, matching the lenient
/// JSON style used across the companions (Models.swift / org.json).
/// Reads and sends are separate methods on purpose: a send is an
/// actuation and the API dispatches it only after a governance
/// approval, exactly like the Android phone_sms_send action.

/// A conversation channel (Messages / iMessage + SMS relay).
public protocol MessageChannel {
    /// Recent messages across conversations, newest first.
    func recentMessages(limit: Int) throws -> [[String: Any]]
    /// One thread with `address` (phone number or Apple ID email).
    func thread(address: String, limit: Int) throws -> [[String: Any]]
    /// Send a message. Actuation — callers must hold a governance
    /// approval before invoking (the API enforces this, as it does
    /// for the Android SMS send action).
    func send(address: String, body: String) throws
}

/// A mail channel (Apple Mail).
public protocol MailChannel {
    /// Recent messages from one mailbox ("inbox" default), newest first.
    func recentMessages(mailbox: String, limit: Int) throws -> [[String: Any]]
    /// Full body of one message by its channel-local id.
    func messageBody(id: String) throws -> [String: Any]
    /// Send mail. Actuation — same governance rule as MessageChannel.send.
    func send(to: String, subject: String, body: String) throws
}

/// Errors with stable machine-readable codes, mirroring the Android
/// bridge's PhoneDataException codes so the API can map them 1:1.
public struct BridgeError: Error, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}
