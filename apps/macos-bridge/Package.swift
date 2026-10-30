// SPDX-License-Identifier: Apache-2.0
// swift-tools-version: 5.9
//
// KriyaDot macOS bridge (Wave-6, DV-8) — SOURCE-LEVEL ONLY.
//
// *** UNVERIFIED: no Swift toolchain or Apple hardware exists on the
// build VM, so this package has never been compiled or run. It must
// be built on a Mac (swift build) and granted Automation permissions
// (System Settings -> Privacy & Security -> Automation) for Messages
// and Mail before any of it can be claimed as working. ***

import PackageDescription

let package = Package(
    name: "KriyaDotMacBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "MacBridgeCore", targets: ["MacBridgeCore"]),
        .executable(name: "kriyadot-mac-bridge", targets: ["KriyaDotMacBridge"]),
    ],
    targets: [
        .target(name: "MacBridgeCore"),
        .executableTarget(name: "KriyaDotMacBridge", dependencies: ["MacBridgeCore"]),
    ]
)
