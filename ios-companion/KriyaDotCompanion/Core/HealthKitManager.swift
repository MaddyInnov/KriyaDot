// SPDX-License-Identifier: Apache-2.0
import Foundation
import HealthKit

/// HealthKit read bridge (Wave-6, DV-2/DV-4 — iOS device side).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
/// There is no Xcode / Swift toolchain on the build VM and the
/// companion is unsigned, so this file has never been compiled or run.
/// It is written against the HealthKit iOS 17 SDK and must pass a real
/// Xcode build (with the HealthKit entitlement + usage strings added
/// alongside it) before the feature can be claimed as working.
///
/// Mirrors android-phone-agent's HealthConnectHandlers.kt: reads the
/// record types the user granted in HealthKit and produces the EXACT
/// sample shape the API's health-sync surface accepts
/// (apps/api/src/health-sync.ts): { externalId, type, value, unit,
/// startAt, endAt, source } with the same type names and canonical
/// units as the Android side, so both platforms land in one store.
/// syncRecentHours posts the batch to POST /api/health-sync/samples;
/// ingest there is idempotent per (deviceId, externalId) — HealthKit
/// sample UUIDs make re-syncs duplication-free.
///
/// Governance: read-only (no write types are ever requested), and a
/// type the user has not shared is reported in `skippedTypes`, never
/// substituted from another source — same contract as Android.
final class HealthKitManager {
    private let healthStore = HKHealthStore()
    private let store: PairingStore
    private let session: URLSession

    init(store: PairingStore, session: URLSession = .shared) {
        self.store = store
        self.session = session
    }

    /// API type name -> (HealthKit quantity type, canonical unit, HKUnit).
    private struct TypeSpec {
        let quantityId: HKQuantityTypeIdentifier
        let apiUnit: String
        let hkUnit: HKUnit
    }

    private static let quantityTypes: [String: TypeSpec] = [
        "steps": TypeSpec(quantityId: .stepCount, apiUnit: "count", hkUnit: .count()),
        "distance": TypeSpec(quantityId: .distanceWalkingRunning, apiUnit: "m", hkUnit: .meter()),
        "heart_rate": TypeSpec(quantityId: .heartRate, apiUnit: "bpm", hkUnit: HKUnit.count().unitDivided(by: .minute())),
        "resting_heart_rate": TypeSpec(quantityId: .restingHeartRate, apiUnit: "bpm", hkUnit: HKUnit.count().unitDivided(by: .minute())),
        "weight": TypeSpec(quantityId: .bodyMass, apiUnit: "kg", hkUnit: .gramUnit(with: .kilo)),
        "height": TypeSpec(quantityId: .height, apiUnit: "m", hkUnit: .meter()),
        "blood_oxygen": TypeSpec(quantityId: .oxygenSaturation, apiUnit: "%", hkUnit: .percent()),
        "blood_glucose": TypeSpec(quantityId: .bloodGlucose, apiUnit: "mmol/L", hkUnit: HKUnit.moleUnit(with: .milli, molarMass: HKUnit.MolarMassBloodGlucose).unitDivided(by: .liter())),
        "active_calories": TypeSpec(quantityId: .activeEnergyBurned, apiUnit: "kcal", hkUnit: .kilocalorie()),
        "respiratory_rate": TypeSpec(quantityId: .respiratoryRate, apiUnit: "rpm", hkUnit: HKUnit.count().unitDivided(by: .minute())),
        "body_temperature": TypeSpec(quantityId: .bodyTemperature, apiUnit: "Cel", hkUnit: .degreeCelsius()),
    ]

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// The full read set this bridge can request (quantity + sleep + BP pair).
    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        for spec in Self.quantityTypes.values {
            if let t = HKObjectType.quantityType(forIdentifier: spec.quantityId) { set.insert(t) }
        }
        set.insert(HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!)
        if let sys = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic) { set.insert(sys) }
        if let dia = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic) { set.insert(dia) }
        return set
    }

    /// Ask iOS for read access. The completion reports only whether the
    /// prompt was shown/handled — HealthKit deliberately never reveals
    /// per-type read grants to the app, so unshared types simply return
    /// no samples and surface via `skippedTypes` (empty result).
    func requestAuthorization() async throws {
        guard Self.isAvailable else { throw APIError.server("healthkit_unavailable") }
        try await healthStore.requestAuthorization(toShare: [], read: readTypes)
    }

    /// Fetch samples for the last `hoursBack` hours in API shape.
    /// Returns (samples, skippedTypes) — a requested type with no
    /// samples in the window is listed as skipped (may mean unshared
    /// or simply no data; HealthKit does not distinguish).
    func fetchSamples(types requested: [String]?, hoursBack: Int) async throws -> (samples: [[String: Any]], skippedTypes: [String]) {
        guard Self.isAvailable else { throw APIError.server("healthkit_unavailable") }
        let hours = min(max(hoursBack, 1), 168)
        let end = Date()
        let start = end.addingTimeInterval(-Double(hours) * 3600)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        let wanted = requested?.filter { Self.quantityTypes[$0] != nil || $0 == "sleep" || $0 == "blood_pressure" }
            ?? Array(Self.quantityTypes.keys) + ["sleep", "blood_pressure"]

        var samples: [[String: Any]] = []
        var skipped: [String] = []
        for type in wanted {
            let before = samples.count
            if type == "sleep" {
                samples += try await fetchSleep(predicate: predicate)
            } else if type == "blood_pressure" {
                samples += try await fetchBloodPressure(predicate: predicate)
            } else if let spec = Self.quantityTypes[type] {
                samples += try await fetchQuantity(type: type, spec: spec, predicate: predicate)
            }
            if samples.count == before { skipped.append(type) }
        }
        return (samples, skipped)
    }

    private func fetchQuantity(type: String, spec: TypeSpec, predicate: NSPredicate) async throws -> [[String: Any]] {
        guard let quantityType = HKObjectType.quantityType(forIdentifier: spec.quantityId) else { return [] }
        let results: [HKSample] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(
                sampleType: quantityType, predicate: predicate, limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error { cont.resume(throwing: error) } else { cont.resume(returning: samples ?? []) }
            }
            healthStore.execute(q)
        }
        return results.compactMap { sample in
            guard let q = sample as? HKQuantitySample else { return nil }
            var dict: [String: Any] = [
                "externalId": q.uuid.uuidString,
                "type": type,
                "value": q.quantity.doubleValue(for: spec.hkUnit),
                "unit": spec.apiUnit,
                "startAt": Int(q.startDate.timeIntervalSince1970 * 1000),
                "endAt": Int(q.endDate.timeIntervalSince1970 * 1000),
            ]
            if !q.sourceRevision.source.name.isEmpty { dict["source"] = q.sourceRevision.source.name }
            return dict
        }
    }

    private func fetchSleep(predicate: NSPredicate) async throws -> [[String: Any]] {
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let results: [HKSample] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(
                sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error { cont.resume(throwing: error) } else { cont.resume(returning: samples ?? []) }
            }
            healthStore.execute(q)
        }
        return results.compactMap { sample in
            guard let c = sample as? HKCategorySample, c.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue
                || c.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue
                || c.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue
                || c.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue
            else { return nil }
            let durationMs = Int(c.endDate.timeIntervalSince(c.startDate) * 1000)
            var dict: [String: Any] = [
                "externalId": c.uuid.uuidString,
                "type": "sleep",
                "value": durationMs,
                "unit": "ms",
                "startAt": Int(c.startDate.timeIntervalSince1970 * 1000),
                "endAt": Int(c.endDate.timeIntervalSince1970 * 1000),
            ]
            if !c.sourceRevision.source.name.isEmpty { dict["source"] = c.sourceRevision.source.name }
            return dict
        }
    }

    private func fetchBloodPressure(predicate: NSPredicate) async throws -> [[String: Any]] {
        let bpType = HKObjectType.correlationType(forIdentifier: .bloodPressure)!
        let results: [HKSample] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(
                sampleType: bpType, predicate: predicate, limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error { cont.resume(throwing: error) } else { cont.resume(returning: samples ?? []) }
            }
            healthStore.execute(q)
        }
        let mmHg = HKUnit.millimeterOfMercury()
        return results.compactMap { sample in
            guard let corr = sample as? HKCorrelation,
                  let sys = corr.objects(for: HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic)!).first as? HKQuantitySample,
                  let dia = corr.objects(for: HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic)!).first as? HKQuantitySample
            else { return nil }
            var dict: [String: Any] = [
                "externalId": corr.uuid.uuidString,
                "type": "blood_pressure",
                "value": [
                    "systolic": sys.quantity.doubleValue(for: mmHg),
                    "diastolic": dia.quantity.doubleValue(for: mmHg),
                ],
                "unit": "mmHg",
                "startAt": Int(corr.startDate.timeIntervalSince1970 * 1000),
                "endAt": Int(corr.endDate.timeIntervalSince1970 * 1000),
            ]
            if !corr.sourceRevision.source.name.isEmpty { dict["source"] = corr.sourceRevision.source.name }
            return dict
        }
    }

    /// Fetch + POST one sync batch to the API health-sync surface.
    /// Returns the server's { inserted, duplicates } counts.
    @discardableResult
    func syncRecentHours(_ hoursBack: Int, types: [String]? = nil) async throws -> [String: Any] {
        let (samples, _) = try await fetchSamples(types: types, hoursBack: hoursBack)
        var req = URLRequest(url: URL(string: store.baseUrl + "/api/health-sync/samples")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(store.deviceToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.httpBody = jsonBody(["deviceId": store.deviceId, "samples": samples])
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.http((response as? HTTPURLResponse)?.statusCode ?? -1, jsonObject(data).optString("error"))
        }
        return jsonObject(data)
    }
}
