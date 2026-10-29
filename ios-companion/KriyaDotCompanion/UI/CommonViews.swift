// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Shared screen chrome helpers: error banner fed from the view
/// model's error state, empty-state hint, and the live-socket line.
/// Mirrors android-companion's Common.kt.
struct ErrorBanner: ViewModifier {
    @ObservedObject var vm: CompanionViewModel

    func body(content: Content) -> some View {
        content
            .alert("Something went wrong", isPresented: errorBinding) {
                Button("OK") { vm.clearError() }
            } message: {
                Text(vm.error ?? "")
            }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { vm.error != nil },
            set: { if !$0 { vm.clearError() } }
        )
    }
}

extension View {
    func errorBanner(vm: CompanionViewModel) -> some View {
        modifier(ErrorBanner(vm: vm))
    }
}

struct EmptyHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.body)
            .foregroundStyle(.secondary)
            .padding(.top, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SocketStatusLine: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        Text(vm.socketLive ? "● Live updates" : "○ Reconnecting…")
            .font(.caption.weight(.medium))
            .foregroundStyle(vm.socketLive ? Color.accentColor : Color.secondary)
    }
}

/// Banner shown when the server rejected our device token and the
/// socket stopped (Android: rePairRequired state).
struct RePairBanner: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        if vm.rePairRequired {
            VStack(alignment: .leading, spacing: 8) {
                Text("This device's token was rejected by the server.")
                    .font(.subheadline.weight(.semibold))
                Text("Pair again to keep controlling this KriyaDot instance.")
                    .font(.subheadline)
                Button("Unpair and pair again", role: .destructive) {
                    vm.unpair()
                }
                .buttonStyle(.bordered)
            }
            .padding()
            .background(Color.red.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}
