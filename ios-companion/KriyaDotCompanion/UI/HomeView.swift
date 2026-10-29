// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Home: server health, active runs summary, pending approvals count.
/// Mirrors Android's HomeScreen.kt.
struct HomeView: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                RePairBanner(vm: vm)
                SocketStatusLine(vm: vm)
                if let s = vm.status {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.healthy ? "● Server healthy" : "● Server unreachable")
                            .font(.headline)
                            .foregroundStyle(s.healthy ? Color.accentColor : Color.red)
                        Text(s.version.isEmpty ? s.serverName : "\(s.serverName) v\(s.version)")
                        Text("Connected to \(vm.store.serverLabel)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text("Paired as \(vm.store.deviceName.isEmpty ? "this device" : vm.store.deviceName)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    HStack(spacing: 12) {
                        StatCard(value: "\(s.activeRuns)", label: "Active runs", highlight: false)
                        StatCard(value: "\(s.pendingApprovals)", label: "Pending approvals", highlight: s.pendingApprovals > 0)
                    }
                } else {
                    Text("Connecting to \(vm.store.serverLabel)…")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
        .navigationTitle("KriyaDot")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refreshAll() } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
            }
        }
        .errorBanner(vm: vm)
    }
}

private struct StatCard: View {
    let value: String
    let label: String
    let highlight: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.title)
                .foregroundStyle(highlight ? Color.red : Color.primary)
            Text(label).font(.footnote)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
