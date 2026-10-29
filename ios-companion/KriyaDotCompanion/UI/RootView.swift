// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// App shell: pairing screen when unpaired, otherwise the tab bar
/// (Home / Approvals / Runs / Chat / More) mirroring Android's
/// MainActivity bottom navigation. Push taps route "needs you" ->
/// approvals inbox, "done"/"failed" -> chat (Android: pushRouteFor).
struct RootView: View {
    @StateObject private var vm = CompanionViewModel()
    @State private var selection = "home"

    private static let tabs = ["home", "approvals", "runs", "chat", "more"]

    var body: some View {
        Group {
            if vm.paired {
                TabView(selection: $selection) {
                    NavigationStack { HomeView(vm: vm) }
                        .tabItem { Label("Home", systemImage: "house") }
                        .tag("home")
                    NavigationStack { ApprovalsView(vm: vm) }
                        .tabItem { Label("Approvals", systemImage: "checklist") }
                        .tag("approvals")
                        .badge(vm.approvals.count)
                    NavigationStack { RunsView(vm: vm) }
                        .tabItem { Label("Runs", systemImage: "play.circle") }
                        .tag("runs")
                    NavigationStack { ChatView(vm: vm) }
                        .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                        .tag("chat")
                    NavigationStack { MoreView(vm: vm) }
                        .tabItem { Label("More", systemImage: "ellipsis") }
                        .tag("more")
                }
                .onChange(of: vm.pushNavTarget) { target in
                    if let target, Self.tabs.contains(target) {
                        selection = target
                        vm.pushNavTarget = nil
                    }
                }
            } else {
                PairingView(vm: vm)
            }
        }
    }
}
