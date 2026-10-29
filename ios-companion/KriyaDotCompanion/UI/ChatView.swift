// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// Chat with the KriyaDot instance. Mirrors the web app's POST /api/chat
/// turn API: the assistant reply streams token-by-token into the last
/// bubble.
///
/// The bot the message is addressed to is picked from the roster
/// (GET /api/companion/bots) with the picker above the conversation;
/// the selection persists in PairingStore and is sent as botId in the
/// request. Mirrors Android's ChatScreen.kt.
struct ChatView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var input = ""

    var body: some View {
        VStack(spacing: 0) {
            BotPickerRow(vm: vm)
            Divider()
            if vm.messages.isEmpty {
                Spacer()
                Text("Ask KriyaDot anything.")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(vm.messages) { msg in
                                MessageBubble(message: msg)
                                    .id(msg.id)
                            }
                        }
                        .padding(12)
                    }
                    .onChange(of: vm.messages.last?.text) { _ in
                        if let last = vm.messages.last {
                            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message KriyaDot…", text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                Button {
                    vm.sendChat(input)
                    input = ""
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || vm.chatBusy || vm.selectedBotId == nil)
                .accessibilityLabel("Send")
                Button {
                    vm.clearChat()
                } label: {
                    Image(systemName: "trash")
                }
                .disabled(vm.messages.isEmpty || vm.chatBusy)
                .accessibilityLabel("Clear chat")
            }
            .padding(8)
        }
        .navigationTitle("Chat")
        .onAppear { vm.ensureBots() }
        .errorBanner(vm: vm)
    }
}

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        let isUser = message.role == "user"
        HStack {
            if isUser { Spacer(minLength: 40) }
            Text(message.text.isEmpty ? "…" : message.text)
                .padding(12)
                .foregroundStyle(isUser ? Color.primary : Color.primary)
                .background(isUser ? Color.accentColor.opacity(0.25) : Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            if !isUser { Spacer(minLength: 8) }
        }
    }
}

/// Chat bot picker backed by GET /api/companion/bots: a menu of the
/// roster (defaults to the first bot), "Loading bots…" while fetching,
/// and "No bots available" when the roster comes back empty.
private struct BotPickerRow: View {
    @ObservedObject var vm: CompanionViewModel

    var body: some View {
        HStack {
            if vm.botsLoading && vm.bots.isEmpty {
                ProgressView().controlSize(.small)
                Text("Loading bots…").padding(.leading, 8)
            } else if vm.bots.isEmpty {
                Text("No bots available").foregroundStyle(.red)
            } else {
                Menu {
                    ForEach(vm.bots) { bot in
                        Button(bot.name) { vm.selectBot(id: bot.id) }
                    }
                } label: {
                    HStack {
                        Text("Bot: \(selectedName)")
                        Image(systemName: "chevron.up.chevron.down")
                    }
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var selectedName: String {
        vm.bots.first { $0.id == vm.selectedBotId }?.name ?? ""
    }
}
