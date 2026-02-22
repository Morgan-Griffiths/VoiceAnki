import Foundation

struct CardCandidate: Codable, Identifiable, Equatable {
    let candidateID: String
    let cardType: CardType
    let front: String?
    let back: String?
    let clozeText: String?
    let rationale: String
    let tags: [String]

    var id: String { candidateID }

    enum CardType: String, Codable, CaseIterable {
        case basic
        case cloze
    }

    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id"
        case cardType = "card_type"
        case front
        case back
        case clozeText = "cloze_text"
        case rationale
        case tags
    }
}

struct GenerateCardsResponse: Codable {
    let cards: [CardCandidate]
    let model: String?
}

struct TranscribeResponse: Codable {
    let clipId: String?
    let transcript: String
    let model: String?

    enum CodingKeys: String, CodingKey {
        case clipId = "clipId"
        case transcript
        case model
    }
}

struct FeedbackResponse: Codable {
    let ok: Bool
    let feedbackId: String?
    let count: Int?
}

