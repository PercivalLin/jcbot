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
    let observationId: String
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

struct TargetDescriptor: Codable {
    let candidateId: String?
    let label: String?
    let role: String?
    let source: String
    let bounds: SnapshotBounds?
    let observationId: String?
    let screenshotRef: String?
    let snapshotAt: String?

    private enum CodingKeys: String, CodingKey {
        case candidateId
        case id
        case label
        case role
        case source
        case bounds
        case observationId
        case screenshotRef
        case snapshotRef
        case snapshotAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        candidateId = try container.decodeIfPresent(String.self, forKey: .candidateId) ??
            container.decodeIfPresent(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        role = try container.decodeIfPresent(String.self, forKey: .role)
        source = try container.decode(String.self, forKey: .source)
        bounds = try container.decodeIfPresent(SnapshotBounds.self, forKey: .bounds)
        observationId = try container.decodeIfPresent(String.self, forKey: .observationId)
        screenshotRef = try container.decodeIfPresent(String.self, forKey: .screenshotRef) ??
            container.decodeIfPresent(String.self, forKey: .snapshotRef)
        snapshotAt = try container.decodeIfPresent(String.self, forKey: .snapshotAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(candidateId, forKey: .candidateId)
        try container.encodeIfPresent(label, forKey: .label)
        try container.encodeIfPresent(role, forKey: .role)
        try container.encode(source, forKey: .source)
        try container.encodeIfPresent(bounds, forKey: .bounds)
        try container.encodeIfPresent(observationId, forKey: .observationId)
        try container.encodeIfPresent(screenshotRef, forKey: .screenshotRef)
        try container.encodeIfPresent(snapshotAt, forKey: .snapshotAt)
    }
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
    let sequence: Int
}

struct WindowDescriptor {
    let ownerName: String
    let title: String
}

struct ActionRequest {
    let actionId: String
    let actionKind: String
    let approvalToken: ApprovalPayload?
    let runId: String
    let target: String?
    let text: String?
    let args: [String: String]
    let rawArgs: Any
    let targetDescriptor: TargetDescriptor?

    init(params: [String: String]?) {
        self.actionId = params?["actionId"] ?? ""
        self.actionKind = params?["actionKind"] ?? ""
        self.runId = params?["runId"] ?? ""
        self.target = params?["target"]
        self.text = params?["text"]

        if let approvalTokenJson = params?["approvalTokenJson"],
           let data = approvalTokenJson.data(using: .utf8) {
            self.approvalToken = try? JSONDecoder().decode(ApprovalPayload.self, from: data)
        } else {
            self.approvalToken = nil
        }

        var parsedArgs: Any = [String: Any]()
        if let argsJson = params?["argsJson"],
           let data = argsJson.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) {
            parsedArgs = parsed
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

        if let descriptorJson = params?["targetDescriptorJson"],
           let data = descriptorJson.data(using: .utf8),
           let descriptor = try? JSONDecoder().decode(TargetDescriptor.self, from: data) {
            self.targetDescriptor = descriptor
        } else if let dictionary = parsedArgs as? [String: Any],
                  let descriptorObject = dictionary["targetDescriptor"],
                  JSONSerialization.isValidJSONObject(descriptorObject),
                  let data = try? JSONSerialization.data(withJSONObject: descriptorObject),
                  let descriptor = try? JSONDecoder().decode(TargetDescriptor.self, from: data) {
            self.targetDescriptor = descriptor
        } else {
            self.targetDescriptor = nil
        }
    }
}
