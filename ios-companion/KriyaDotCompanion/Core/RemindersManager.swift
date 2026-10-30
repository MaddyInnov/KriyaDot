// SPDX-License-Identifier: Apache-2.0
import Foundation
import EventKit

/// Apple Reminders read surface (Wave-6, DV-2 — iOS device side).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
/// No Xcode / Swift toolchain exists on the build VM and the companion
/// is unsigned, so this file has never been compiled or run. It needs
/// NSRemindersFullAccessUsageDescription (added to Info.plist
/// alongside it) and a real device before it can be claimed working.
///
/// Shape mirrors the Android phone-agent's calendar data shape
/// (PhoneDataHandlers.kt): a flat list of items with title, timing and
/// a location/notes field, in the companion's lenient dictionary
/// style. READ-ONLY: completing or creating reminders from the
/// companion is an actuation and stays behind API governance.
final class RemindersManager {
    private let eventStore = EKEventStore()

    /// Request full reminders access (iOS 17+ API). Returns the grant.
    func requestAccess() async -> Bool {
        do {
            return try await eventStore.requestFullAccessToReminders()
        } catch {
            return false
        }
    }

    /// Reminders (optionally only incomplete ones) across all lists.
    /// `daysAhead` mirrors the Android calendar query param semantics
    /// (window from now, clamped 1...31); reminders without a due date
    /// are included only when `includeUndated` is true.
    func fetchReminders(daysAhead: Int = 7, includeCompleted: Bool = false, includeUndated: Bool = false) async throws -> [[String: Any]] {
        let days = min(max(daysAhead, 1), 31)
        let now = Date()
        let end = now.addingTimeInterval(Double(days) * 24 * 3600)
        let calendars = eventStore.calendars(for: .reminder)
        let predicate = eventStore.predicateForReminders(in: calendars)
        let reminders: [EKReminder] = try await withCheckedThrowingContinuation { cont in
            eventStore.fetchReminders(matching: predicate) { found in
                cont.resume(returning: found ?? [])
            }
        }
        return reminders.compactMap { reminder in
            if reminder.isCompleted && !includeCompleted { return nil }
            let due = reminder.dueDateComponents?.date
            if let due {
                if due < now.addingTimeInterval(-24 * 3600) || due > end { return nil }
            } else if !includeUndated {
                return nil
            }
            var dict: [String: Any] = [
                "id": reminder.calendarItemIdentifier,
                "title": reminder.title ?? "",
                "list": reminder.calendar.title,
                "completed": reminder.isCompleted,
                "priority": reminder.priority,
            ]
            if let due { dict["dueAt"] = Int(due.timeIntervalSince1970 * 1000) }
            if let notes = reminder.notes, !notes.isEmpty { dict["notes"] = notes }
            if let location = reminder.structuredLocation?.title, !location.isEmpty { dict["location"] = location }
            return dict
        }
    }
}
