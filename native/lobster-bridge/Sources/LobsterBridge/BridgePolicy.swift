import Foundation

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

    static func validate(actionKind: String, approvalToken: String?) -> PolicyValidationResult {
        if hardRedActionKinds.contains(actionKind) {
            return PolicyValidationResult(
                allowed: false,
                reason: "Bridge hard gate rejected redline action \(actionKind)."
            )
        }

        if yellowApprovalActionKinds.contains(actionKind) && (approvalToken == nil || approvalToken?.isEmpty == true) {
            return PolicyValidationResult(
                allowed: false,
                reason: "Yellow action requires an approval token at the bridge boundary."
            )
        }

        return PolicyValidationResult(
            allowed: true,
            reason: "Action allowed by bridge policy."
        )
    }
}
