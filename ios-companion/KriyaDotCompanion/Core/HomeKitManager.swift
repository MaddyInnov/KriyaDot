// SPDX-License-Identifier: Apache-2.0
import Foundation
import HomeKit

/// HomeKit read surface (Wave-6, DV-2 — iOS device side).
///
/// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
/// No Xcode / Swift toolchain exists on the build VM and the companion
/// is unsigned, so this file has never been compiled or run. It needs
/// the HomeKit entitlement + NSHomeKitUsageDescription (added
/// alongside it) and a real device paired to a home before it can be
/// claimed as working.
///
/// Shape mirrors the companion's other read surfaces (lenient
/// [String: Any] dictionaries, same as Models.swift): homes ->
/// accessories -> services -> characteristics, READ-ONLY. This
/// manager deliberately exposes no write path: characteristic writes
/// (turning devices on/off) are actuations and belong behind the
/// API's governance approvals, not in a companion read bridge.
final class HomeKitManager: NSObject {
    private let homeManager = HMHomeManager()
    private var homesContinuation: CheckedContinuation<[HMHome], Never>?

    /// All homes visible to this device, in companion dictionary shape.
    /// Waits for HMHomeManager to finish its initial load
    /// (homeManagerDidUpdateHomes) — the standard HomeKit pattern.
    func fetchHomes() async -> [[String: Any]] {
        let homes = await withCheckedContinuation { (cont: CheckedContinuation<[HMHome], Never>) in
            homesContinuation = cont
            homeManager.delegate = self
            if homeManager.homes.isEmpty == false {
                homesContinuation = nil
                cont.resume(returning: homeManager.homes)
            }
        }
        return homes.map { home in
            [
                "id": home.uniqueIdentifier.uuidString,
                "name": home.name,
                "isPrimary": home.isPrimary,
                "rooms": home.rooms.map { room in
                    ["id": room.uniqueIdentifier.uuidString, "name": room.name]
                },
                "accessories": home.accessories.map { accessory in
                    [
                        "id": accessory.uniqueIdentifier.uuidString,
                        "name": accessory.name,
                        "room": accessory.room?.name ?? "",
                        "manufacturer": accessory.manufacturer ?? "",
                        "model": accessory.model ?? "",
                        "reachable": accessory.isReachable,
                        "blocked": accessory.isBlocked,
                        "services": accessory.services.map { service in
                            [
                                "id": service.uniqueIdentifier.uuidString,
                                "name": service.name,
                                "type": service.serviceType,
                                "characteristics": service.characteristics.map { characteristic in
                                    [
                                        "id": characteristic.uniqueIdentifier.uuidString,
                                        "type": characteristic.characteristicType,
                                        "properties": characteristic.properties,
                                        "value": characteristic.value.map { "\($0)" } ?? "",
                                    ]
                                },
                            ]
                        },
                    ]
                },
            ]
        }
    }
}

extension HomeKitManager: HMHomeManagerDelegate {
    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        guard let cont = homesContinuation else { return }
        homesContinuation = nil
        cont.resume(returning: manager.homes)
    }
}
