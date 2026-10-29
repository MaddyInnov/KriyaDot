// SPDX-License-Identifier: Apache-2.0
import AVFoundation
import SwiftUI
import UIKit

/// QR scanner for the pairing code, built on AVFoundation
/// (AVCaptureSession + QR metadata output) — the iOS counterpart of
/// Android's ZXing scan. The camera is used ONLY to scan the pairing QR,
/// as declared in NSCameraUsageDescription. On the simulator or a
/// camera-less device the preview shows a placeholder and the manual
/// entry fallback remains available.
struct QRScannerView: UIViewControllerRepresentable {
    /// Called with the raw scanned string (any QR content; QrParser
    /// validates it upstream), once per presentation.
    var onScan: (String) -> Void
    var onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: ScannerViewController, coordinator: Coordinator) {
        uiViewController.stopSession()
    }

    final class Coordinator: NSObject, ScannerViewControllerDelegate {
        let onScan: (String) -> Void
        let onCancel: () -> Void
        private var didScan = false

        init(onScan: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
            self.onScan = onScan
            self.onCancel = onCancel
        }

        func scanner(didScan value: String) {
            guard !didScan else { return }
            didScan = true
            onScan(value)
        }

        func scannerDidCancel() {
            onCancel()
        }
    }
}

protocol ScannerViewControllerDelegate: AnyObject {
    func scanner(didScan value: String)
    func scannerDidCancel()
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    weak var delegate: ScannerViewControllerDelegate?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var configured = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if configured {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                if !session.isRunning { session.startRunning() }
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    func stopSession() {
        if session.isRunning { session.stopRunning() }
    }

    @objc private func cancelTapped() {
        delegate?.scannerDidCancel()
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            // No camera (simulator / camera-less device): leave the
            // black placeholder; manual entry is the fallback.
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
        configured = true
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        stopSession()
        delegate?.scanner(didScan: value)
    }
}
