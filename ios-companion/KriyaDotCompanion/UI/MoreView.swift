// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Overflow tab: links to Activity + Briefing + Remote screen, pairing
/// details, unpair. Mirrors Android's MoreScreen.kt.
struct MoreView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var confirmUnpair = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Paired server").font(.caption).foregroundStyle(.secondary)
                    Text(vm.store.serverLabel).font(.headline)
                    Text("Device: \(vm.store.deviceName.isEmpty ? "this device" : vm.store.deviceName)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            Section {
                NavigationLink("Activity feed") { ActivityView(vm: vm) }
                NavigationLink("Briefing") { BriefingView(vm: vm) }
                NavigationLink {
                    RemoteScreenView(vm: vm)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Remote screen")
                        Text("Watch this PC's screen (approval required)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Button(role: .destructive) {
                    confirmUnpair = true
                } label: {
                    Label("Unpair this device", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            Section {
                Text("KriyaDot Companion 1.0.0 — MVP")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("More")
        .errorBanner(vm: vm)
        .alert("Unpair this device?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { vm.unpair() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The stored device token is deleted and this phone stops controlling the KriyaDot instance.")
        }
    }
}
