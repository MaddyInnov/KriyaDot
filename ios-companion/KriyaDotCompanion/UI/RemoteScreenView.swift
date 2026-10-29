// SPDX-License-Identifier: Apache-2.0
import SwiftUI
import UIKit

/// Remote screen: watch the paired PC's live screen from the phone.
///
/// Flow: Start -> server mints an approval -> the PC owner approves in
/// the KriyaDot web UI -> frames stream over the WebSocket frame channel
/// (base64 PNG frames, ~4 fps). View-only: the phone cannot drive the
/// PC from this screen. Mirrors Android's ScreenShareScreen.kt.
struct RemoteScreenView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Watch this PC's screen live. Sharing starts only after you approve it in the KriyaDot web UI, and stops automatically after 30 minutes.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if vm.screenSession == nil && vm.screenImage == nil {
                // Idle: nothing requested yet (or just ended).
                if let note = vm.screenNote, !note.isEmpty {
                    Text(note)
                }
                Button("Start screen sharing") { vm.startScreenShare() }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
            } else if vm.screenImage == nil {
                // Waiting for approval / connecting.
                VStack(spacing: 12) {
                    ProgressView()
                    Text(vm.screenNote ?? "Connecting…")
                }
                .frame(maxWidth: .infinity)
                .frame(height: 220)
                Button("Cancel") { vm.stopScreenShare() }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
            } else {
                // Live frames with pinch-to-zoom and pan — the
                // MagnificationGesture equivalent of Android's
                // detectTransformGestures zoom (clamped 1x…6x).
                Text(((vm.screenSession?.mock == true) ? "Preview mode · " : "") + (vm.screenNote ?? "Live"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.accentColor)
                ZoomableScreenImage(image: vm.screenImage!, scale: $scale, lastScale: $lastScale, offset: $offset, lastOffset: $lastOffset)
                    .frame(maxWidth: .infinity)
                Button("Stop sharing") { vm.stopScreenShare() }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
            }
            Spacer()
        }
        .padding(16)
        .navigationTitle("Remote screen")
        .errorBanner(vm: vm)
        // Stop the session when the user navigates away — NOT on
        // rotation. SwiftUI keeps this view alive across rotation (the
        // navigation stack is untouched), while onDisappear fires when
        // the view is popped, which is exactly Android's route-check
        // behavior in ScreenShareScreen.
        .onDisappear {
            vm.stopScreenShare()
        }
    }
}

/// Pinch-zoomable frame view: MagnificationGesture for zoom plus a
/// drag for pan while zoomed, mirroring Android's ZoomableScreenImage.
private struct ZoomableScreenImage: View {
    let image: UIImage
    @Binding var scale: CGFloat
    @Binding var lastScale: CGFloat
    @Binding var offset: CGSize
    @Binding var lastOffset: CGSize

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { value in
                        scale = min(max(lastScale * value, 1), 6)
                    }
                    .onEnded { _ in
                        lastScale = scale
                        if scale <= 1 {
                            offset = .zero
                            lastOffset = .zero
                        }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        guard scale > 1 else { return }
                        offset = CGSize(
                            width: lastOffset.width + value.translation.width,
                            height: lastOffset.height + value.translation.height
                        )
                    }
                    .onEnded { _ in
                        lastOffset = offset
                    }
            )
    }
}
