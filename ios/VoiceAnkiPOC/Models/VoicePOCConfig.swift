import Foundation

struct VoicePOCConfig {
    // Replace with your Mac's LAN IP to test on device, e.g. "http://192.168.1.20:5179"
    var baseURLString: String = "http://127.0.0.1:5179"

    var baseURL: URL {
        guard let url = URL(string: baseURLString) else {
            preconditionFailure("Invalid backend URL: \(baseURLString)")
        }
        return url
    }
}

