import Foundation

final class APIClient {
    private let session: URLSession
    private let config: VoicePOCConfig
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(config: VoicePOCConfig = VoicePOCConfig(), session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    func transcribe(audioData: Data, mimeType: String = "audio/mp4", language: String?) async throws -> TranscribeResponse {
        struct Body: Encodable {
            let audioBase64: String
            let mimeType: String
            let language: String?
        }

        let dataURL = "data:\(mimeType);base64,\(audioData.base64EncodedString())"
        let body = Body(audioBase64: dataURL, mimeType: mimeType, language: language?.nilIfEmpty)
        return try await post(path: "/api/voice/transcribe", body: body, as: TranscribeResponse.self)
    }

    func generateCards(transcript: String, n: Int, style: CardCandidate.CardType?) async throws -> GenerateCardsResponse {
        struct Body: Encodable {
            let transcript: String
            let n: Int
            let style: String
        }

        let styleValue: String
        if let style {
            styleValue = style.rawValue
        } else {
            styleValue = "mixed"
        }

        let body = Body(transcript: transcript, n: n, style: styleValue)
        return try await post(path: "/api/voice/cards/generate", body: body, as: GenerateCardsResponse.self)
    }

    func saveFeedback(
        clipId: String?,
        transcript: String,
        chosenCandidateID: String,
        chosenCard: CardCandidate,
        allCandidates: [CardCandidate],
        userReason: String
    ) async throws -> FeedbackResponse {
        struct Body: Encodable {
            let clipId: String?
            let transcript: String
            let chosenCandidateId: String
            let chosenCard: CardCandidate
            let allCandidates: [CardCandidate]
            let userReason: String
        }

        let body = Body(
            clipId: clipId,
            transcript: transcript,
            chosenCandidateId: chosenCandidateID,
            chosenCard: chosenCard,
            allCandidates: allCandidates,
            userReason: userReason
        )
        return try await post(path: "/api/voice/feedback", body: body, as: FeedbackResponse.self)
    }

    private func post<Body: Encodable, Response: Decodable>(
        path: String,
        body: Body,
        as responseType: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path.trimmingPrefixSlash()))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? decoder.decode(ServerErrorResponse.self, from: data).error) ?? "HTTP \(httpResponse.statusCode)"
            throw APIError.server(message)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}

private struct ServerErrorResponse: Decodable {
    let error: String
}

enum APIError: LocalizedError {
    case invalidResponse
    case server(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response."
        case .server(let message):
            return message
        case .decoding(let message):
            return "Response decoding failed: \(message)"
        }
    }
}

private extension String {
    func trimmingPrefixSlash() -> String {
        hasPrefix("/") ? String(dropFirst()) : self
    }

    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

