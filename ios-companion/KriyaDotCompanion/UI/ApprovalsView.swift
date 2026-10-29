// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Pending approvals with approve/deny + confirmation dialog +
/// optional note. Mirrors Android's ApprovalsScreen.kt.
struct ApprovalsView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var deciding: Decision?

    private struct Decision: Identifiable {
        let approval: Approval
        let approve: Bool
        var id: String { approval.id + (approve ? "-approve" : "-deny") }
    }

    var body: some View {
        Group {
            if vm.approvals.isEmpty {
                ScrollView { EmptyHint(text: "Nothing waiting for approval.") .padding(.horizontal, 16) }
            } else {
                List(vm.approvals) { approval in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(approval.title).font(.headline)
                        if !approval.detail.isEmpty {
                            Text(approval.detail).font(.body)
                        }
                        let meta = [approval.sessionId, approval.createdAt].filter { !$0.isEmpty }.joined(separator: " · ")
                        if !meta.isEmpty {
                            Text(meta).font(.footnote).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 12) {
                            Button("Approve") { deciding = Decision(approval: approval, approve: true) }
                                .buttonStyle(.borderedProminent)
                            Button("Deny") { deciding = Decision(approval: approval, approve: false) }
                                .buttonStyle(.bordered)
                        }
                        .padding(.top, 6)
                    }
                    .padding(.vertical, 8)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Approvals")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refreshApprovals() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .errorBanner(vm: vm)
        .sheet(item: $deciding) { decision in
            DecisionSheet(vm: vm, decision: (decision.approval, decision.approve)) {
                deciding = nil
            }
        }
    }
}

private struct DecisionSheet: View {
    @ObservedObject var vm: CompanionViewModel
    let decision: (approval: Approval, approve: Bool)
    var onDone: () -> Void
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(decision.approval.title)
                }
                Section {
                    TextField("Note (optional)", text: $note)
                }
            }
            .navigationTitle(decision.approve ? "Approve this?" : "Deny this?")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDone() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(decision.approve ? "Approve" : "Deny") {
                        vm.decideApproval(
                            id: decision.approval.id,
                            approve: decision.approve,
                            note: note.trimmingCharacters(in: .whitespaces).isEmpty ? nil : note
                        )
                        onDone()
                    }
                }
            }
        }
    }
}
