// SPDX-License-Identifier: Apache-2.0
import SwiftUI
import UIKit

/// First-run pairing: scan the QR shown in KriyaDot Workspace ->
/// Devices, confirm the server, and exchange the one-time token for a
/// long-lived device token. iOS asks for camera permission with the
/// Info.plist rationale; a manual entry fallback stays available when
/// the camera is denied or missing. Mirrors Android's PairingScreen.kt.
struct PairingView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var showScanner = false
    @State private var showManual = false
    @State private var showRationale = false

    var body: some View {
        // A scanned/entered payload awaiting confirmation replaces the
        // landing content (Android shows a dialog; an inline swap avoids
        // stacking two sheet presentations on one view).
        if vm.pendingPairing != nil {
            ConfirmPairingView(vm: vm)
        } else {
            landing
        }
    }

    private var landing: some View {
        VStack(spacing: 0) {
            Spacer()
            Text("Pair with KriyaDot")
                .font(.title2.weight(.semibold))
            Text("Scan the QR code shown in KriyaDot Workspace → Devices on your PC.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
            Button("Scan QR code") { showScanner = true }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            Button("Enter details manually") { showManual = true }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
                .sheet(isPresented: $showManual) {
                    ManualPairingView { payload in
                        showManual = false
                        vm.onQrScanned(payload)
                    }
                }
            if showRationale {
                Text("Camera access is used only to scan the pairing QR. You can deny it and enter the host, port and token manually instead.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 16)
            }
            if let error = vm.pairingError {
                Text(error)
                    .foregroundStyle(.red)
                    .padding(.top, 16)
            }
            Spacer()
        }
        .padding(24)
        .fullScreenCover(isPresented: $showScanner) {
            QRScannerView(
                onScan: { raw in
                    showScanner = false
                    vm.onQrScanned(QrParser.parse(raw))
                },
                onCancel: { showScanner = false }
            )
            .ignoresSafeArea()
        }
        .overlay {
            if vm.pairingBusy {
                ZStack {
                    Color.black.opacity(0.3).ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Exchanging pairing token…")
                    }
                    .padding(24)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

private struct ConfirmPairingView: View {
    @ObservedObject var vm: CompanionViewModel
    @State private var name = UIDevice.current.name

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: vm.pendingPairing?.serverLabel ?? "")
                    if vm.pendingPairing?.isHosted == true {
                        Text("Hosted server — the phone will connect over the internet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("Device name", text: $name)
                }
                if let error = vm.pairingError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Pair with this server?")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { vm.clearPendingPairing() }
                        .disabled(vm.pairingBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") { vm.confirmPairing(deviceName: name) }
                        .disabled(vm.pairingBusy)
                }
            }
        }
        .overlay {
            if vm.pairingBusy {
                ZStack {
                    Color.black.opacity(0.3).ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Exchanging pairing token…")
                    }
                    .padding(24)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

/// Manual fallback: LAN host/port/token or hosted URL/token, producing
/// the same PairingPayload the QR path produces (same validation via
/// QrParser, like Android's ManualPairingDialog).
private struct ManualPairingView: View {
    var onConfirm: (PairingPayload?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var hosted = false
    @State private var host = ""
    @State private var port = ""
    @State private var serverUrl = ""
    @State private var token = ""
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Mode", selection: $hosted) {
                    Text("WiFi (LAN)").tag(false)
                    Text("Hosted").tag(true)
                }
                .pickerStyle(.segmented)
                if hosted {
                    Section {
                        Text("Connect to a hosted KriyaDot server over the internet. Ask the server owner for its public URL and a pairing code (Workspace → Devices → Generate pairing code).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        TextField("Server URL (https://…)", text: $serverUrl)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                } else {
                    Section {
                        TextField("Host (LAN IP)", text: $host)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Port", text: $port)
                            .keyboardType(.numberPad)
                    }
                }
                Section {
                    TextField("One-time token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if invalid {
                    Section {
                        Text("Those details don't form a valid pairing payload.")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Enter pairing details")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Continue") {
                        let payload = makePayload()
                        invalid = payload == nil
                        if let payload { onConfirm(payload) }
                    }
                }
            }
        }
    }

    private func makePayload() -> PairingPayload? {
        if hosted {
            let url = QrParser.normalizeServerUrl(serverUrl)
            let ott = token.trimmingCharacters(in: .whitespaces)
            guard let url, !ott.isEmpty else { return nil }
            return PairingPayload(host: "", port: 0, ott: ott, serverUrl: url)
        }
        return QrParser.parse("kriyadot://pair?host=\(host.trimmingCharacters(in: .whitespaces))&port=\(port.trimmingCharacters(in: .whitespaces))&token=\(token.trimmingCharacters(in: .whitespaces))")
    }
}
