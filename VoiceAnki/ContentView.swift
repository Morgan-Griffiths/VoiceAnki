import SwiftUI
import Combine
import AVFoundation
import UIKit
import Foundation

@MainActor
final class RecorderViewModel: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var isTranscribing = false
    @Published private(set) var elapsedSeconds: TimeInterval = 0
    @Published private(set) var statusText = "Ready"
    @Published var transcriptText: String = ""
    @Published var backendBaseURL: String = "http://192.168.1.2:5179" // Replace with your Mac's LAN IP

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var recordingStart: Date?
    private var lastFileURL: URL?

    func toggleTapRecording() {
        if isRecording {
            stopRecording()
        } else {
            Task { await startRecordingFromUI() }
        }
    }

    func beginHoldRecording() {
        guard !isRecording else { return }
        Task { await startRecordingFromUI() }
    }

    func endHoldRecording() {
        guard isRecording else { return }
        stopRecording()
    }

    private func startRecordingFromUI() async {
        do {
            try await requestMicrophonePermission()
            try startRecording()
            statusText = "Recording..."
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func requestMicrophonePermission() async throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let granted = await withCheckedContinuation { continuation in
            session.requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
        if !granted {
            throw RecorderError.microphoneDenied
        }
    }

    private func startRecording() throws {
        guard !isRecording else { return }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voiceanki-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            AVEncoderBitRateKey: 96_000
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self

        guard recorder.record() else {
            throw RecorderError.failedToStart
        }

        self.recorder = recorder
        self.lastFileURL = url
        self.recordingStart = Date()
        self.elapsedSeconds = 0
        self.isRecording = true
        startTimer()
    }

    func stopRecording() {
        guard isRecording else { return }
        recorder?.stop()
        stopTimer()
        isRecording = false

        if let start = recordingStart {
            elapsedSeconds = Date().timeIntervalSince(start)
        }

        if let url = lastFileURL {
            statusText = String(format: "Saved %.1fs recording. Transcribing...", elapsedSeconds)
            Task { await transcribeRecording(at: url) }
        } else {
            statusText = String(format: "Saved %.1fs recording", elapsedSeconds)
        }
    }

    private func transcribeRecording(at url: URL) async {
        guard !isTranscribing else { return }
        isTranscribing = true
        defer { isTranscribing = false }

        do {
            let trimmedBase = backendBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let endpoint = URL(string: trimmedBase)?.appendingPathComponent("api/voice/transcribe") else {
                throw RecorderError.invalidBackendURL
            }

            let data = try Data(contentsOf: url)
            let body = TranscribeRequest(
                audioBase64: "data:audio/mp4;base64,\(data.base64EncodedString())",
                mimeType: "audio/mp4",
                language: nil
            )

            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 90
            request.httpBody = try JSONEncoder().encode(body)

            let (responseData, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw RecorderError.invalidServerResponse
            }

            guard (200..<300).contains(http.statusCode) else {
                if let serverError = try? JSONDecoder().decode(ServerErrorResponse.self, from: responseData) {
                    throw RecorderError.server(serverError.error)
                }
                throw RecorderError.server("HTTP \(http.statusCode)")
            }

            let decoded = try JSONDecoder().decode(TranscribeResponse.self, from: responseData)
            transcriptText = decoded.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            statusText = "Transcription complete" + (decoded.model.map { " (\($0))" } ?? "")
        } catch {
            statusText = "Transcription failed: \(error.localizedDescription)"
        }
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, let start = self.recordingStart else { return }
            self.elapsedSeconds = Date().timeIntervalSince(start)
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
}

extension RecorderViewModel: AVAudioRecorderDelegate {
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        stopTimer()
        isRecording = false
        isTranscribing = false
        statusText = error?.localizedDescription ?? "Recording failed"
    }
}

private struct TranscribeRequest: Encodable {
    let audioBase64: String
    let mimeType: String
    let language: String?
}

private struct TranscribeResponse: Decodable {
    let clipId: String?
    let transcript: String
    let model: String?
}

private struct ServerErrorResponse: Decodable {
    let error: String
}

enum RecorderError: LocalizedError {
    case microphoneDenied
    case failedToStart
    case invalidBackendURL
    case invalidServerResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "Microphone access denied. Enable it in Settings."
        case .failedToStart:
            return "Failed to start recording."
        case .invalidBackendURL:
            return "Invalid backend URL. Update it to your Mac LAN IP."
        case .invalidServerResponse:
            return "Invalid server response."
        case .server(let message):
            return message
        }
    }
}

struct HoldToRecordButton: UIViewRepresentable {
    let title: String
    let holdThresholdSeconds: TimeInterval
    let isRecording: Bool
    let isDisabled: Bool
    let onTap: () -> Void
    let onHoldStart: () -> Void
    let onHoldEnd: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.configuration = .filled()
        button.configuration?.cornerStyle = .capsule
        button.configuration?.contentInsets = .init(top: 20, leading: 20, bottom: 20, trailing: 20)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchDown), for: .touchDown)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchUpInside), for: .touchUpInside)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchUpOutside), for: .touchUpOutside)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchCancel), for: .touchCancel)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.parent = self
        var config = button.configuration ?? .filled()
        config.title = title
        config.baseForegroundColor = .white
        config.baseBackgroundColor = isRecording ? .systemRed : .systemBlue
        button.configuration = config
        button.isEnabled = !isDisabled
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject {
        var parent: HoldToRecordButton
        private var isPressed = false
        private var holdTriggered = false
        private var holdWorkItem: DispatchWorkItem?

        init(parent: HoldToRecordButton) {
            self.parent = parent
        }

        @objc func touchDown() {
            isPressed = true
            holdTriggered = false
            holdWorkItem?.cancel()

            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.isPressed, !self.holdTriggered else { return }
                self.holdTriggered = true
                self.parent.onHoldStart()
            }
            holdWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + parent.holdThresholdSeconds, execute: work)
        }

        @objc func touchUpInside() { handleRelease(cancelled: false) }
        @objc func touchUpOutside() { handleRelease(cancelled: true) }
        @objc func touchCancel() { handleRelease(cancelled: true) }

        private func handleRelease(cancelled: Bool) {
            guard isPressed else { return }
            isPressed = false
            holdWorkItem?.cancel()
            holdWorkItem = nil

            if holdTriggered {
                holdTriggered = false
                parent.onHoldEnd()
                return
            }

            if !cancelled {
                parent.onTap()
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var vm = RecorderViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Backend URL")
                            .font(.headline)
                        TextField("http://<your-mac-ip>:5179", text: $vm.backendBaseURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                        Text("Set this to the Mac running `node server.js`.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))

                    HoldToRecordButton(
                        title: buttonTitle,
                        holdThresholdSeconds: 0.5,
                        isRecording: vm.isRecording,
                        isDisabled: vm.isTranscribing,
                        onTap: { vm.toggleTapRecording() },
                        onHoldStart: { vm.beginHoldRecording() },
                        onHoldEnd: { vm.endHoldRecording() }
                    )
                    .frame(maxWidth: .infinity)
                    .frame(height: 88)

                    VStack(spacing: 8) {
                        HStack {
                            Label(
                                vm.isRecording ? "Recording" : (vm.isTranscribing ? "Transcribing" : "Idle"),
                                systemImage: vm.isRecording ? "waveform" : (vm.isTranscribing ? "hourglass" : "mic")
                            )
                            .foregroundStyle(vm.isRecording ? .red : (vm.isTranscribing ? .orange : .secondary))
                            Spacer()
                            Text(String(format: "%.1fs", vm.elapsedSeconds))
                                .monospacedDigit()
                                .font(.title3.weight(.medium))
                        }
                        .padding()
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))

                        if vm.isTranscribing {
                            ProgressView("Transcribing...")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Text(vm.statusText)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Transcript")
                            .font(.headline)
                        if vm.transcriptText.isEmpty {
                            Text("Record a clip and the transcription will appear here automatically.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(vm.transcriptText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("How it works")
                            .font(.headline)
                        Text("Quick tap: toggles recording on/off.")
                        Text("Hold for 0.5s+: starts hold-to-record, release stops recording.")
                        Text("After stop, the app automatically uploads the audio and displays the transcript.")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                }
                .padding()
            }
            .navigationTitle("Voice Anki")
        }
    }

    private var buttonTitle: String {
        if vm.isTranscribing {
            return "Transcribing..."
        }
        return vm.isRecording ? "Recording... tap to stop or release after hold" : "Tap or Hold to Record"
    }
}

#Preview {
    ContentView()
}
