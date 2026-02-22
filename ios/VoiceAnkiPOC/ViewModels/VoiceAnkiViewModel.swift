import Foundation
import SwiftUI

@MainActor
final class VoiceAnkiViewModel: ObservableObject {
    enum StyleOption: String, CaseIterable, Identifiable {
        case mixed
        case basic
        case cloze

        var id: String { rawValue }
    }

    @Published var transcript: String = ""
    @Published var cards: [CardCandidate] = []
    @Published var selectedCardID: String?
    @Published var variantCount: Int = 3
    @Published var style: StyleOption = .mixed
    @Published var language: String = ""
    @Published var preferenceReason: String = ""
    @Published var statusMessages: [String] = ["Ready"]
    @Published var clipID: String?
    @Published var isBusy = false

    let recorder = AudioRecorderService()

    private let apiClient: APIClient

    init(apiClient: APIClient = APIClient()) {
        self.apiClient = apiClient
    }

    func onPushToTalkDown() {
        Task {
            do {
                try await recorder.requestMicrophonePermission()
                try recorder.startRecording()
                appendStatus("Recording started")
            } catch {
                appendStatus("Recording failed: \(error.localizedDescription)")
            }
        }
    }

    func onPushToTalkUp() {
        recorder.stopRecording()
        appendStatus("Recording stopped (\(String(format: "%.1fs", recorder.elapsedSeconds)))")
    }

    func transcribeLatest() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let audioData = try recorder.currentAudioData()
            appendStatus("Uploading \(audioData.count) bytes for transcription...")
            let response = try await apiClient.transcribe(
                audioData: audioData,
                mimeType: "audio/mp4",
                language: language.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            clipID = response.clipId
            transcript = response.transcript
            appendStatus("Transcription complete (\(response.model ?? "unknown model"))")
        } catch {
            appendStatus("Transcription failed: \(error.localizedDescription)")
        }
    }

    func generateCards() async {
        guard !isBusy else { return }
        let trimmedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTranscript.isEmpty else {
            appendStatus("Transcript is empty")
            return
        }
        isBusy = true
        defer { isBusy = false }

        do {
            let n = min(max(variantCount, 1), 5)
            let styleParam: CardCandidate.CardType?
            switch style {
            case .mixed:
                styleParam = nil
            case .basic:
                styleParam = .basic
            case .cloze:
                styleParam = .cloze
            }
            appendStatus("Generating \(n) card variants...")
            let response = try await apiClient.generateCards(transcript: trimmedTranscript, n: n, style: styleParam)
            cards = response.cards
            selectedCardID = response.cards.first?.candidateID
            appendStatus("Generated \(response.cards.count) cards (\(response.model ?? "unknown model"))")
        } catch {
            appendStatus("Card generation failed: \(error.localizedDescription)")
        }
    }

    func savePreference() async {
        guard !isBusy else { return }
        guard let selectedCardID else {
            appendStatus("Select a card first")
            return
        }
        guard let chosen = cards.first(where: { $0.candidateID == selectedCardID }) else {
            appendStatus("Selected card missing")
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let response = try await apiClient.saveFeedback(
                clipId: clipID,
                transcript: transcript,
                chosenCandidateID: chosen.candidateID,
                chosenCard: chosen,
                allCandidates: cards,
                userReason: preferenceReason
            )
            appendStatus("Preference saved (count=\(response.count ?? 0))")
        } catch {
            appendStatus("Save preference failed: \(error.localizedDescription)")
        }
    }

    private func appendStatus(_ message: String) {
        let timestamp = Self.timeFormatter.string(from: Date())
        statusMessages.insert("[\(timestamp)] \(message)", at: 0)
        statusMessages = Array(statusMessages.prefix(100))
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm:ss a"
        return formatter
    }()
}

