import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: VoiceAnkiViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    recordSection
                    transcriptSection
                    generationSection
                    cardsSection
                    feedbackSection
                    statusSection
                }
                .padding()
            }
            .navigationTitle("Voice -> Anki")
        }
    }

    private var recordSection: some View {
        cardContainer("Record") {
            PushToTalkButton(
                isRecording: viewModel.recorder.isRecording,
                isDisabled: viewModel.isBusy,
                onPressDown: viewModel.onPushToTalkDown,
                onPressUp: viewModel.onPushToTalkUp
            )
            .frame(maxWidth: .infinity)
            .frame(height: 72)

            HStack {
                Label(viewModel.recorder.isRecording ? "Recording" : "Idle", systemImage: viewModel.recorder.isRecording ? "waveform" : "mic")
                Spacer()
                Text(String(format: "%.1fs", viewModel.recorder.elapsedSeconds))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .bottom, spacing: 12) {
                TextField("Language (optional, e.g. en)", text: $viewModel.language)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                Button("Transcribe") {
                    Task { await viewModel.transcribeLatest() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.isBusy)
            }
        }
    }

    private var transcriptSection: some View {
        cardContainer("Transcript") {
            TextEditor(text: $viewModel.transcript)
                .frame(minHeight: 130)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color(uiColor: .secondarySystemBackground))
                )
        }
    }

    private var generationSection: some View {
        cardContainer("Generate") {
            Stepper("Variants: \(viewModel.variantCount)", value: $viewModel.variantCount, in: 1...5)

            Picker("Style", selection: $viewModel.style) {
                ForEach(VoiceAnkiViewModel.StyleOption.allCases) { style in
                    Text(style.rawValue).tag(style)
                }
            }
            .pickerStyle(.segmented)

            Button {
                Task { await viewModel.generateCards() }
            } label: {
                if viewModel.isBusy {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Generate Cards")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isBusy)
        }
    }

    private var cardsSection: some View {
        cardContainer("Candidates") {
            if viewModel.cards.isEmpty {
                Text("No candidates yet")
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 12) {
                    ForEach(viewModel.cards) { card in
                        CandidateCardRow(
                            card: card,
                            isSelected: viewModel.selectedCardID == card.candidateID,
                            onSelect: { viewModel.selectedCardID = card.candidateID }
                        )
                    }
                }
            }
        }
    }

    private var feedbackSection: some View {
        cardContainer("Preference") {
            TextField("Why this version? (optional)", text: $viewModel.preferenceReason)
                .textFieldStyle(.roundedBorder)

            Button("Save Choice") {
                Task { await viewModel.savePreference() }
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isBusy || viewModel.selectedCardID == nil)
        }
    }

    private var statusSection: some View {
        cardContainer("Status") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(viewModel.statusMessages.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private func cardContainer<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(uiColor: .systemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(uiColor: .separator), lineWidth: 0.6)
        )
    }
}

private struct CandidateCardRow: View {
    let card: CardCandidate
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(isSelected ? .teal : .secondary)
                    Text(card.candidateID)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(card.cardType.rawValue)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if card.cardType == .cloze {
                    field("Cloze", card.clozeText ?? "")
                } else {
                    field("Front", card.front ?? "")
                    field("Back", card.back ?? "")
                }

                if !card.rationale.isEmpty {
                    Text("Why: \(card.rationale)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(uiColor: .secondarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? Color.teal : Color.clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func field(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

