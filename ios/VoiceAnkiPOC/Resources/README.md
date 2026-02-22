# VoiceAnkiPOC (SwiftUI)

Native iOS starter app that talks to the local `anki-code` backend endpoints:

- `POST /api/voice/transcribe`
- `POST /api/voice/cards/generate`
- `POST /api/voice/feedback`

## What is included

- Push-to-talk button (touch down starts, release stops)
- Local AAC (`.m4a`) recording via `AVAudioRecorder`
- Transcription call to the backend
- Card generation (N variants)
- Candidate picker + feedback save
- Basic status log

## How to run on device (Xcode)

1. In Xcode, create a new **iOS App** project named `VoiceAnkiPOC`.
2. Replace the generated Swift files with the files in this folder (or drag these files into the project).
3. Add `NSMicrophoneUsageDescription` to the app's `Info.plist`:
   - Example: `Record voice to generate Anki cards`
4. Update the backend URL in `ios/VoiceAnkiPOC/Models/VoicePOCConfig.swift`:
   - `http://<YOUR-MAC-LAN-IP>:5179`
5. Start the backend server in this repo:
   - `OPENAI_API_KEY=... node server.js`
6. Make sure iPhone and Mac are on the same network.
7. Run the app on your device from Xcode.

## Notes

- This uses HTTP to your local network backend. If your iOS app blocks this request, add an ATS exception for local development (or use local HTTPS).
- Feedback is stored in server memory only in the current backend POC.
- The backend currently defaults transcription to `whisper-1`; you can change it via `OPENAI_TRANSCRIBE_MODEL`.
