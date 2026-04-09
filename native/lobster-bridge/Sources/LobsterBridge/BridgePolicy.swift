import Foundation
import CryptoKit

enum BridgePolicy {
    static let hardRedActionKinds: Set<String> = [
        "external.send_message",
        "file.delete",
        "record.delete",
        "commerce.pay",
        "commerce.checkout",
        "security.privilege_escalation",
        "policy.modify",
        "runtime.modify",
        "bridge.modify"
    ]

    static let yellowApprovalActionKinds: Set<String> = [
        "external.select_contact",
        "external.upload_file",
        "ui.edit_existing"
    ]

    static func validate(action: ActionRequest, now: Date = Date()) -> PolicyValidationResult {
        let actionKind = action.actionKind
        if action.actionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return PolicyValidationResult(
                allowed: false,
                reason: "Action request is missing canonical actionId."
            )
        }

        if action.runId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return PolicyValidationResult(
                allowed: false,
                reason: "Action request is missing canonical runId."
            )
        }

        if hardRedActionKinds.contains(actionKind) {
            return PolicyValidationResult(
                allowed: false,
                reason: "Bridge hard gate rejected redline action \(actionKind)."
            )
        }

        if yellowApprovalActionKinds.contains(actionKind) {
            guard let approvalToken = action.approvalToken else {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Yellow action requires a structured approval token at the bridge boundary."
                )
            }

            if approvalToken.id.isEmpty || approvalToken.runId.isEmpty || approvalToken.approvedBy.isEmpty {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token is missing required identity fields."
                )
            }

            if approvalToken.riskLevel != "yellow" {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token risk level must remain yellow."
                )
            }

            if approvalToken.singleUse == false {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token must remain single-use at the bridge boundary."
                )
            }

            guard let expiration = parseApprovalExpiration(approvalToken.expiresAt), expiration > now else {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token expired before the bridge attempted the action."
                )
            }

            if approvalToken.runId != action.runId {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token runId does not match the current bridge request."
                )
            }

            let expectedFingerprint = actionFingerprint(for: action)
            if approvalToken.actionFingerprint != expectedFingerprint {
                return PolicyValidationResult(
                    allowed: false,
                    reason: "Approval token fingerprint does not match the current bridge action payload."
                )
            }
        }

        return PolicyValidationResult(
            allowed: true,
            reason: "Action allowed by bridge policy."
        )
    }

    private static func parseApprovalExpiration(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: raw) {
            return parsed
        }

        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    static func actionFingerprint(for action: ActionRequest) -> String {
        var payload: [String: Any] = [
            "actionId": action.actionId,
            "args": canonicalArgs(action.rawArgs),
            "kind": action.actionKind
        ]
        if let target = action.target, target.isEmpty == false {
            payload["target"] = target
        }

        if let descriptor = canonicalTargetDescriptor(action.targetDescriptor) {
            payload["targetDescriptor"] = descriptor
        }

        let canonical = canonicalJSONString(payload)
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func canonicalArgs(_ rawArgs: Any) -> Any {
        guard let dictionary = rawArgs as? [String: Any] else {
            return rawArgs
        }

        var result: [String: Any] = [:]
        for (key, value) in dictionary where key != "targetDescriptor" {
            result[key] = value
        }
        return result
    }

    private static func canonicalTargetDescriptor(_ descriptor: TargetDescriptor?) -> [String: Any]? {
        guard let descriptor else {
            return nil
        }

        var payload: [String: Any] = [
            "candidateId": descriptor.candidateId ?? "",
            "label": descriptor.label ?? "",
            "source": descriptor.source
        ]
        if let role = descriptor.role {
            payload["role"] = role
        }
        if let observationId = descriptor.observationId {
            payload["observationId"] = observationId
        }
        if let screenshotRef = descriptor.screenshotRef {
            payload["screenshotRef"] = screenshotRef
        }
        if let snapshotAt = descriptor.snapshotAt {
            payload["snapshotAt"] = snapshotAt
        }
        if let bounds = descriptor.bounds {
            payload["bounds"] = [
                "height": bounds.height,
                "width": bounds.width,
                "x": bounds.x,
                "y": bounds.y
            ]
        }
        return payload
    }

    private static func canonicalJSONString(_ value: Any) -> String {
        switch value {
        case is NSNull:
            return "null"
        case let string as String:
            return encodedScalarJSON(string)
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return number.boolValue ? "true" : "false"
            }
            return encodedScalarJSON(number)
        case let array as [Any]:
            return "[" + array.map { canonicalJSONString($0) }.joined(separator: ",") + "]"
        case let dictionary as [String: Any]:
            let serialized = dictionary.keys.sorted().map { key in
                "\(encodedScalarJSON(key)):\(canonicalJSONString(dictionary[key] ?? NSNull()))"
            }
            return "{" + serialized.joined(separator: ",") + "}"
        default:
            return encodedScalarJSON(String(describing: value))
        }
    }

    private static func encodedScalarJSON(_ value: Any) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
           let text = String(data: data, encoding: .utf8),
           text.count >= 2 {
            return String(text.dropFirst().dropLast()).replacingOccurrences(of: "\\/", with: "/")
        }

        return "\"\""
    }
}
