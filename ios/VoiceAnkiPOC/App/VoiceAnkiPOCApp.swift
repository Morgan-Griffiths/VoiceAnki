import SwiftUI

@main
struct VoiceAnkiPOCApp: App {
    @StateObject private var viewModel = VoiceAnkiViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
        }
    }
}

