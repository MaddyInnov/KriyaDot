// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Activity feed: latest events from the KriyaDot instance.
/// Mirrors Android's ActivityScreen in ActivityBriefingScreens.kt.
struct ActivityView: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        Group {
            if vm.activity.isEmpty {
                ScrollView { EmptyHint(text: "No activity yet.").padding(.horizontal, 16) }
            } else {
                List(vm.activity) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.text)
                        let meta = [item.kind, item.createdAt].filter { !$0.isEmpty }.joined(separator: " · ")
                        if !meta.isEmpty {
                            Text(meta).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Activity")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refreshActivity() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .errorBanner(vm: vm)
    }
}

/// Latest briefing digest from the server.
/// Mirrors Android's BriefingScreen in ActivityBriefingScreens.kt.
struct BriefingView: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        Group {
            if let b = vm.briefing, !b.body.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(b.title).font(.title3.weight(.semibold))
                        if !b.generatedAt.isEmpty {
                            Text(b.generatedAt).font(.footnote).foregroundStyle(.secondary)
                        }
                        Text(b.body)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .padding(16)
                }
            } else {
                ScrollView { EmptyHint(text: "No briefing available yet.").padding(.horizontal, 16) }
            }
        }
        .navigationTitle("Briefing")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refreshBriefing() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .errorBanner(vm: vm)
    }
}
