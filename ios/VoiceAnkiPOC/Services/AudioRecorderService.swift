import AVFoundation
import Foundation

@MainActor
final class AudioRecorderService: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsedSeconds: TimeInterval = 0

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var recordingStartedAt: Date?
    private(set) var currentFileURL: URL?

    func requestMicrophonePermission() async throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)
        let granted = await withCheckedContinuation { continuation in
            session.requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
        if !granted { throw RecorderError.microphoneDenied }
    }

    func startRecording() throws {
        guard !isRecording else { return }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let outputURL = Self.makeOutputURL()
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            AVEncoderBitRateKey: 96_000
        ]

        let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true

        guard recorder.record() else {
            throw RecorderError.failedToStart
        }

        self.recorder = recorder
        self.currentFileURL = outputURL
        self.recordingStartedAt = Date()
        self.elapsedSeconds = 0
        self.isRecording = true
        startTimer()
    }

    func stopRecording() {
        guard isRecording else { return }
        recorder?.stop()
        stopTimer()
        isRecording = false
        elapsedSeconds = max(elapsedSeconds, 0)
    }

    func currentAudioData() throws -> Data {
        guard let fileURL = currentFileURL else {
            throw RecorderError.noRecording
        }
        return try Data(contentsOf: fileURL)
    }

    func clearCurrentRecording() {
        stopRecording()
        if let currentFileURL {
            try? FileManager.default.removeItem(at: currentFileURL)
        }
        self.currentFileURL = nil
        self.elapsedSeconds = 0
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard let startedAt = self.recordingStartedAt else { return }
            self.elapsedSeconds = Date().timeIntervalSince(startedAt)
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private static func makeOutputURL() -> URL {
        let dir = FileManager.default.temporaryDirectory
        return dir.appendingPathComponent("voice-anki-\(UUID().uuidString).m4a")
    }
}

extension AudioRecorderService: AVAudioRecorderDelegate {
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        isRecording = false
        stopTimer()
    }
}

enum RecorderError: LocalizedError {
    case microphoneDenied
    case failedToStart
    case noRecording

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "Microphone access denied. Enable it in Settings."
        case .failedToStart:
            return "Failed to start recording."
        case .noRecording:
            return "No recording available."
        }
    }
}
