// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Runs list with pause / resume / cancel actions (cancel asks for
/// confirmation). Mirrors Android's RunsScreen.kt.
struct RunsView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var cancelling: RunSummary?

    var body: some View {
        Group {
            if vm.runs.isEmpty {
                ScrollView { EmptyHint(text: "No runs right now.").padding(.horizontal, 16) }
            } else {
                List(vm.runs) { run in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(run.label).font(.headline)
                            Spacer()
                            Text(run.state)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.accentColor)
                        }
                        if !run.detail.isEmpty {
                            Text(run.detail).font(.body)
                        }
                        HStack(spacing: 12) {
                            if run.state.caseInsensitiveCompare("paused") == .orderedSame {
                                Button("Resume") { vm.runAction(id: run.id, action: "resume") }
                                    .buttonStyle(.borderedProminent)
                            } else {
                                Button("Pause") { vm.runAction(id: run.id, action: "pause") }
                                    .buttonStyle(.bordered)
                            }
                            Button("Cancel") { cancelling = run }
                                .buttonStyle(.bordered)
                        }
                        .padding(.top, 6)
                    }
                    .padding(.vertical, 8)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Runs")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refreshRuns() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .errorBanner(vm: vm)
        .alert("Cancel this run?", isPresented: cancelBinding) {
            Button("Cancel run", role: .destructive) {
                if let run = cancelling { vm.runAction(id: run.id, action: "cancel") }
                cancelling = nil
            }
            Button("Keep", role: .cancel) { cancelling = nil }
        } message: {
            Text("“\(cancelling?.label ?? "")” will be stopped. This cannot be undone.")
        }
    }

    private var cancelBinding: Binding<Bool> {
        Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
    }
}
