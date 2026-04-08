import Foundation

struct JsonRpcRequest: Codable {
    let jsonrpc: String
    let id: String
    let method: String
    let params: [String: String]?
}

struct JsonRpcResponse<Result: Codable>: Codable {
    let jsonrpc: String
    let id: String
    let result: Result?
    let error: JsonRpcError?
}

struct JsonRpcError: Codable {
    let code: Int
    let message: String
}

struct BridgeCapabilities: Codable {
    let accessibility: Bool
    let screenCapture: Bool
    let eventTap: Bool
    let ocr: Bool
    let policyHardGate: Bool
}

struct PolicyValidationResult: Codable {
    let allowed: Bool
    let reason: String
}

struct SnapshotResult: Codable {
    let screenshotRef: String
    let activeApp: String
    let activeWindowTitle: String?
    let note: String
    let windows: [String]
    let candidates: [SnapshotCandidate]
}

struct PerformActionResult: Codable {
    let status: String
}

struct SnapshotBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SnapshotCandidate: Codable {
    let id: String
    let role: String
    let label: String
    let value: String?
    let focused: Bool?
    let bounds: SnapshotBounds?
    let confidence: Double
    let source: String
}

struct WindowDescriptor {
    let ownerName: String
    let title: String
}

struct ActionRequest {
    let actionKind: String
    let approvalToken: String?
    let target: String?
    let text: String?
    let args: [String: String]

    init(params: [String: String]?) {
        self.actionKind = params?["actionKind"] ?? ""
        self.approvalToken = params?["approvalToken"]
        self.target = params?["target"]
        self.text = params?["text"]

        if let argsJson = params?["argsJson"],
           let data = argsJson.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            var normalized: [String: String] = [:]
            for (key, value) in parsed {
                if let stringValue = value as? String {
                    normalized[key] = stringValue
                } else {
                    normalized[key] = String(describing: value)
                }
            }
            self.args = normalized
        } else {
            self.args = [:]
        }
    }
}
