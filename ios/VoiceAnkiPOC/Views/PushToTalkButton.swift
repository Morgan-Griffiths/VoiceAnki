import SwiftUI
import UIKit

struct PushToTalkButton: UIViewRepresentable {
    let isRecording: Bool
    let isDisabled: Bool
    let onPressDown: () -> Void
    let onPressUp: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.configuration = .filled()
        button.configuration?.cornerStyle = .large
        button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 18, leading: 14, bottom: 18, trailing: 14)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchDown), for: .touchDown)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchUp), for: .touchUpInside)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchUp), for: .touchUpOutside)
        button.addTarget(context.coordinator, action: #selector(Coordinator.touchUp), for: .touchCancel)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.parent = self
        var config = button.configuration ?? .filled()
        config.title = isRecording ? "Recording... release to stop" : "Hold to Record"
        config.baseBackgroundColor = isRecording ? .systemTeal : .systemOrange
        config.baseForegroundColor = .white
        button.configuration = config
        button.isEnabled = !isDisabled
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject {
        var parent: PushToTalkButton
        private var isPressed = false

        init(parent: PushToTalkButton) {
            self.parent = parent
        }

        @objc func touchDown() {
            guard !isPressed else { return }
            isPressed = true
            parent.onPressDown()
        }

        @objc func touchUp() {
            guard isPressed else { return }
            isPressed = false
            parent.onPressUp()
        }
    }
}

