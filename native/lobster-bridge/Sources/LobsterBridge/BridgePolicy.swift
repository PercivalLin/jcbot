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
            "args": action.rawArgs,
            "kind": action.actionKind
        ]
        if let target = action.target, target.isEmpty == false {
            payload["target"] = target
        }

        let canonical = canonicalJSONString(payload)
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
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
            return String(text.dropFirst().dropLast())
        }

        return "\"\""
    }
}
