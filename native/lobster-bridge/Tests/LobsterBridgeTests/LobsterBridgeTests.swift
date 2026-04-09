import XCTest
import AppKit
@testable import LobsterBridge

final class LobsterBridgeTests: XCTestCase {
    func testHardRedActionIsRejected() {
        let action = ActionRequest(params: [
            "actionId": "action-send",
            "actionKind": "external.send_message",
            "runId": "run-1"
        ])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowContactActionNeedsToken() {
        let action = ActionRequest(params: [
            "actionId": "action-select-contact",
            "actionKind": "external.select_contact",
            "runId": "run-1"
        ])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionNeedsToken() {
        let action = ActionRequest(params: [
            "actionId": "action-upload",
            "actionKind": "external.upload_file",
            "runId": "run-1",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionAllowsWithToken() {
        let action = ActionRequest(params: [
            "actionId": "action-upload",
            "actionKind": "external.upload_file",
            "runId": "run-1",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])
        let payload = approvalTokenJson(for: action)
        let validatedAction = ActionRequest(params: [
            "actionId": "action-upload",
            "actionKind": "external.upload_file",
            "approvalTokenJson": payload,
            "runId": "run-1",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])
        let result = BridgePolicy.validate(action: validatedAction)
        XCTAssertTrue(result.allowed)
    }

    func testYellowUploadActionRejectsMismatchedFingerprint() {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload = ApprovalPayload(
            id: "approval-1",
            runId: "run-1",
            actionFingerprint: "deadbeef",
            riskLevel: "yellow",
            approvedBy: "tester",
            expiresAt: formatter.string(from: Date().addingTimeInterval(300)),
            singleUse: true
        )
        let data = try! JSONEncoder().encode(payload)
        let action = ActionRequest(params: [
            "actionId": "action-upload",
            "actionKind": "external.upload_file",
            "approvalTokenJson": String(decoding: data, as: UTF8.self),
            "runId": "run-1",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])

        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testUnknownOpenAppReturnsNoopStatus() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"1","method":"ui.performAction","params":{"actionId":"action-open-unknown","actionKind":"ui.open_app","runId":"run-1","target":"discovery","text":"open some totally unknown app","argsJson":"{\\"text\\":\\"open some totally unknown app\\"}"}}
        """

        let response = service.handle(line: request)
        XCTAssertTrue(response.contains("noop:no-app-match"))
    }

    func testSnapshotIncludesBridgePrefix() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"2","method":"observation.snapshot"}
        """

        let response = service.handle(line: request)
        let payload = try? JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any]
        let result = payload?["result"] as? [String: Any]
        let observationId = result?["observationId"] as? String
        let screenshotRef = result?["screenshotRef"] as? String
        let recentEvents = result?["recentEvents"] as? [[String: Any]]

        XCTAssertNotNil(observationId)
        XCTAssertTrue(observationId?.hasPrefix("bridge://observation/") ?? false)
        XCTAssertNotNil(screenshotRef)
        XCTAssertTrue(screenshotRef?.hasPrefix("bridge://snapshot/") ?? false)
        XCTAssertNotNil(result?["snapshotAt"])
        XCTAssertNotNil(result?["observationMode"])
        XCTAssertNotNil(result?["ocrText"])
        XCTAssertNotNil(recentEvents)
        XCTAssertNotNil(result?["candidates"])
    }

    func testRecognizeTextExtractsOCRTokensFromGeneratedImage() throws {
        let service = BridgeService()
        let imagePath = try makeTextImage(text: "Lobster OCR", fileName: "ocr-sample.png")

        let observation = service.recognizeText(in: imagePath)

        XCTAssertNotNil(observation)
        XCTAssertTrue(observation?.texts.contains(where: { $0.localizedCaseInsensitiveContains("Lobster") }) ?? false)
        XCTAssertTrue(observation?.candidates.contains(where: { $0.source == "ocr" }) ?? false)
    }

    func testCapabilitiesIncludeProtocolMetadata() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"cap","method":"bridge.describeCapabilities"}
        """

        let response = service.handle(line: request)
        let payload = try? JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any]
        let result = payload?["result"] as? [String: Any]

        XCTAssertEqual(result?["protocolVersion"] as? Int, 3)
        XCTAssertNotNil(result?["supportedActions"])
        XCTAssertNotNil(result?["observationModes"])
    }

    func testHotkeyWithoutArgsReturnsNoop() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"3","method":"ui.performAction","params":{"actionId":"action-hotkey","actionKind":"ui.hotkey","runId":"run-1","argsJson":"{}"}}
        """

        let response = service.handle(line: request)
        XCTAssertTrue(response.contains("noop:no-hotkey"))
    }

    func testConfiguredKnownApplicationsAreUsedForAppResolution() {
        let service = BridgeService()
        let configure = """
        {"jsonrpc":"2.0","id":"4","method":"bridge.configureKnownApplications","params":{"appsJson":"[\\"NotRealChatApp\\"]"}}
        """
        _ = service.handle(line: configure)

        let request = """
        {"jsonrpc":"2.0","id":"5","method":"ui.performAction","params":{"actionId":"action-open-known","actionKind":"ui.open_app","runId":"run-1","target":"discovery","text":"open NotRealChatApp","argsJson":"{\\"text\\":\\"open NotRealChatApp\\"}"}}
        """

        let response = service.handle(line: request)
        XCTAssertFalse(response.contains("noop:no-app-match"))
    }

    func testSelectContactWithoutContactReturnsNoop() {
        let service = BridgeService()
        let request = rpcRequest(
            id: "6",
            method: "ui.performAction",
            params: signedActionParams(
                actionKind: "external.select_contact",
                argsJson: "{\"searchLabelHints\":\"搜索\"}"
            )
        )

        let response = service.handle(line: request)
        XCTAssertTrue(response.contains("noop:no-contact"))
    }

    func testSearchApplicationsReturnsMatchingKnownApp() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"7","method":"bridge.searchApplications","params":{"query":"Safari"}}
        """

        let response = service.handle(line: request)
        let payload = try? JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any]
        let result = payload?["result"] as? [String]

        XCTAssertNotNil(result)
        XCTAssertTrue(result?.contains(where: { $0.localizedCaseInsensitiveContains("Safari") }) ?? false)
    }

    func testActionRequestParsesFirstClassTargetDescriptor() {
        let action = ActionRequest(params: [
            "actionId": "action-click-target",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": """
            {"candidateId":"ocr-1","label":"Lobster OCR","role":"text","source":"ocr","bounds":{"x":12,"y":24,"width":160,"height":32},"observationId":"bridge://observation/test","screenshotRef":"bridge://snapshot/test","snapshotAt":"2026-04-08T12:00:00Z"}
            """
        ])

        XCTAssertEqual(action.targetDescriptor?.candidateId, "ocr-1")
        XCTAssertEqual(action.targetDescriptor?.label, "Lobster OCR")
        XCTAssertEqual(action.targetDescriptor?.source, "ocr")
        XCTAssertEqual(action.targetDescriptor?.bounds?.width, 160)
        XCTAssertEqual(action.targetDescriptor?.observationId, "bridge://observation/test")
        XCTAssertEqual(action.targetDescriptor?.screenshotRef, "bridge://snapshot/test")
    }

    func testCanonicalFingerprintMatchesCrossLayerFixture() {
        let action = ActionRequest(params: [
            "actionId": "action-click-target",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "argsJson": "{}",
            "targetDescriptorJson": """
            {"candidateId":"ocr-1","label":"Lobster OCR","role":"text","source":"ocr","bounds":{"x":12,"y":24,"width":160,"height":32},"observationId":"bridge://observation/test","screenshotRef":"bridge://snapshot/test","snapshotAt":"2026-04-08T12:00:00Z"}
            """
        ])

        XCTAssertEqual(
            BridgePolicy.actionFingerprint(for: action),
            "fa6f55bee39c28e4ec179f4dc30eb3203b6a0b6ecdedb852fb61ba4b272660dd"
        )
    }

    func testCanonicalFingerprintIgnoresNestedTargetDescriptorInArgs() {
        let action = ActionRequest(params: [
            "actionId": "action-click-target",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "argsJson": """
            {"targetDescriptor":{"candidateId":"nested-only","label":"Wrong Descriptor","source":"vision"}}
            """,
            "targetDescriptorJson": """
            {"candidateId":"ocr-1","label":"Lobster OCR","role":"text","source":"ocr","bounds":{"x":12,"y":24,"width":160,"height":32},"observationId":"bridge://observation/test","screenshotRef":"bridge://snapshot/test","snapshotAt":"2026-04-08T12:00:00Z"}
            """
        ])

        XCTAssertEqual(
            BridgePolicy.actionFingerprint(for: action),
            "fa6f55bee39c28e4ec179f4dc30eb3203b6a0b6ecdedb852fb61ba4b272660dd"
        )
    }

    func testTargetDescriptorReencodesUsingCanonicalScreenshotRef() throws {
        let action = ActionRequest(params: [
            "actionId": "action-click-target",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": """
            {"candidateId":"ocr-1","label":"Lobster OCR","role":"text","source":"ocr","bounds":{"x":12,"y":24,"width":160,"height":32},"observationId":"bridge://observation/test","snapshotRef":"bridge://snapshot/test","snapshotAt":"2026-04-08T12:00:00Z"}
            """
        ])

        let data = try JSONEncoder().encode(action.targetDescriptor)
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(payload?["screenshotRef"] as? String, "bridge://snapshot/test")
        XCTAssertNil(payload?["snapshotRef"])
    }

    func testValidatedBoundsFallbackAcceptsFreshOCRDescriptor() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": descriptorJson(
                label: "Lobster OCR",
                source: "ocr",
                observationId: snapshot.observationId,
                snapshotRef: snapshot.ref,
                snapshotAt: snapshot.at
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Lobster OCR")
        XCTAssertNotNil(bounds)
        XCTAssertEqual(bounds?.x, 48)
        XCTAssertEqual(bounds?.width, 200)
    }

    func testValidatedBoundsFallbackRejectsMismatchedObservationId() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target-stale",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": descriptorJson(
                label: "Lobster OCR",
                source: "ocr",
                observationId: "bridge://observation/stale",
                snapshotRef: snapshot.ref,
                snapshotAt: snapshot.at
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Lobster OCR")
        XCTAssertNil(bounds)
    }

    func testValidatedBoundsFallbackRejectsMismatchedScreenshotRef() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target-stale-ref",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": descriptorJson(
                label: "Lobster OCR",
                source: "ocr",
                observationId: snapshot.observationId,
                snapshotRef: "bridge://snapshot/stale",
                snapshotAt: snapshot.at
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Lobster OCR")
        XCTAssertNil(bounds)
    }

    func testValidatedBoundsFallbackRejectsMismatchedSnapshotAt() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target-stale-at",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Lobster OCR",
            "targetDescriptorJson": descriptorJson(
                label: "Lobster OCR",
                source: "ocr",
                observationId: snapshot.observationId,
                snapshotRef: snapshot.ref,
                snapshotAt: "2026-04-08T12:00:00Z"
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Lobster OCR")
        XCTAssertNil(bounds)
    }

    func testValidatedBoundsFallbackRejectsNonVisualDescriptor() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target-ax",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Primary Button",
            "targetDescriptorJson": descriptorJson(
                label: "Primary Button",
                source: "ax",
                observationId: snapshot.observationId,
                snapshotRef: snapshot.ref,
                snapshotAt: snapshot.at
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Primary Button")
        XCTAssertNil(bounds)
    }

    func testValidatedBoundsFallbackRejectsMismatchedLabel() {
        let service = BridgeService()
        let snapshot = latestSnapshotInfo(from: service)
        let action = ActionRequest(params: [
            "actionId": "action-click-target-label",
            "actionKind": "ui.click_target",
            "runId": "run-1",
            "target": "Different Label",
            "targetDescriptorJson": descriptorJson(
                label: "Lobster OCR",
                source: "vision",
                observationId: snapshot.observationId,
                snapshotRef: snapshot.ref,
                snapshotAt: snapshot.at
            )
        ])

        let bounds = service.validatedBoundsFallback(for: action.targetDescriptor, targetLabel: "Different Label")
        XCTAssertNil(bounds)
    }

    func testUploadWithoutPathReturnsNoop() {
        let service = BridgeService()
        let request = rpcRequest(
            id: "8",
            method: "ui.performAction",
            params: signedActionParams(actionKind: "external.upload_file", argsJson: "{}")
        )

        let response = service.handle(line: request)
        XCTAssertTrue(response.contains("noop:no-file-path"))
    }

    private func signedActionParams(
        actionKind: String,
        target: String? = nil,
        text: String? = nil,
        argsJson: String
    ) -> [String: String] {
        var unsignedParams = [
            "actionId": "action-\(actionKind)",
            "actionKind": actionKind,
            "runId": "run-1",
            "argsJson": argsJson
        ]
        if let target {
            unsignedParams["target"] = target
        }
        if let text {
            unsignedParams["text"] = text
        }

        let unsignedAction = ActionRequest(params: unsignedParams)
        unsignedParams["approvalTokenJson"] = approvalTokenJson(for: unsignedAction)
        return unsignedParams
    }

    private func approvalTokenJson(for action: ActionRequest) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload = ApprovalPayload(
            id: "approval-1",
            runId: "run-1",
            actionFingerprint: BridgePolicy.actionFingerprint(for: action),
            riskLevel: "yellow",
            approvedBy: "tester",
            expiresAt: formatter.string(from: Date().addingTimeInterval(300)),
            singleUse: true
        )

        let data = try! JSONEncoder().encode(payload)
        return String(decoding: data, as: UTF8.self)
    }

    private func rpcRequest(id: String, method: String, params: [String: String]? = nil) -> String {
        var payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method
        ]
        if let params {
            payload["params"] = params
        }

        let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
        return String(decoding: data, as: UTF8.self)
    }

    private func latestSnapshotInfo(from service: BridgeService) -> (observationId: String, ref: String, at: String) {
        let request = """
        {"jsonrpc":"2.0","id":"snapshot","method":"observation.snapshot"}
        """
        let response = service.handle(line: request)
        let payload = try! JSONSerialization.jsonObject(with: Data(response.utf8)) as! [String: Any]
        let result = payload["result"] as! [String: Any]
        return (
            observationId: result["observationId"] as! String,
            ref: result["screenshotRef"] as! String,
            at: result["snapshotAt"] as! String
        )
    }

    private func descriptorJson(label: String, source: String, observationId: String, snapshotRef: String, snapshotAt: String) -> String {
        """
        {"candidateId":"\(source)-1","label":"\(label)","role":"text","source":"\(source)","bounds":{"x":48,"y":72,"width":200,"height":40},"observationId":"\(observationId)","screenshotRef":"\(snapshotRef)","snapshotAt":"\(snapshotAt)"}
        """
    }

    private func makeTextImage(text: String, fileName: String) throws -> String {
        let size = NSSize(width: 900, height: 220)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.white.setFill()
        NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()

        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 72, weight: .bold),
            .foregroundColor: NSColor.black
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        attributed.draw(at: NSPoint(x: 48, y: 72))
        image.unlockFocus()

        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "LobsterBridgeTests", code: 1)
        }

        let outputURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(fileName)
        try png.write(to: outputURL, options: [.atomic])
        return outputURL.path
    }
}
