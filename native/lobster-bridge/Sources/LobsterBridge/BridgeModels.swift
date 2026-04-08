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
    let protocolVersion: Int
    let supportedActions: [String]
    let observationModes: [String]
}

struct PolicyValidationResult: Codable {
    let allowed: Bool
    let reason: String
}

struct ApprovalPayload: Codable {
    let id: String
    let runId: String
    let actionFingerprint: String
    let riskLevel: String
    let approvedBy: String
    let expiresAt: String
    let singleUse: Bool
}

struct SnapshotResult: Codable {
    let screenshotRef: String
    let activeApp: String
    let activeWindowTitle: String?
    let note: String
    let ocrText: [String]
    let windows: [String]
    let snapshotAt: String
    let screenshotPath: String?
    let observationMode: String
    let focusedElement: SnapshotCandidate?
    let recentEvents: [SnapshotEvent]
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

struct SnapshotEvent: Codable {
    let id: String
    let kind: String
    let message: String
    let createdAt: String
}

struct WindowDescriptor {
    let ownerName: String
    let title: String
}

struct ActionRequest {
    let actionKind: String
    let approvalToken: ApprovalPayload?
    let target: String?
    let text: String?
    let args: [String: String]
    let rawArgs: Any

    init(params: [String: String]?) {
        self.actionKind = params?["actionKind"] ?? ""
        self.target = params?["target"]
        self.text = params?["text"]

        if let approvalTokenJson = params?["approvalTokenJson"],
           let data = approvalTokenJson.data(using: .utf8) {
            self.approvalToken = try? JSONDecoder().decode(ApprovalPayload.self, from: data)
        } else {
            self.approvalToken = nil
        }

        if let argsJson = params?["argsJson"],
           let data = argsJson.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) {
            self.rawArgs = parsed
            var normalized: [String: String] = [:]
            if let dictionary = parsed as? [String: Any] {
                for (key, value) in dictionary {
                    if let stringValue = value as? String {
                        normalized[key] = stringValue
                    } else {
                        normalized[key] = String(describing: value)
                    }
                }
            }
            self.args = normalized
        } else {
            self.rawArgs = [String: Any]()
            self.args = [:]
        }
    }
}
