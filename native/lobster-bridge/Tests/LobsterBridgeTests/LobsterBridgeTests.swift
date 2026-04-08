import XCTest
import AppKit
@testable import LobsterBridge

final class LobsterBridgeTests: XCTestCase {
    func testHardRedActionIsRejected() {
        let action = ActionRequest(params: ["actionKind": "external.send_message"])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowContactActionNeedsToken() {
        let action = ActionRequest(params: ["actionKind": "external.select_contact"])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionNeedsToken() {
        let action = ActionRequest(params: [
            "actionKind": "external.upload_file",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])
        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionAllowsWithToken() {
        let action = ActionRequest(params: [
            "actionKind": "external.upload_file",
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])
        let payload = approvalTokenJson(for: action)
        let validatedAction = ActionRequest(params: [
            "actionKind": "external.upload_file",
            "approvalTokenJson": payload,
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
            "actionKind": "external.upload_file",
            "approvalTokenJson": String(decoding: data, as: UTF8.self),
            "argsJson": "{\"filePath\":\"/tmp/report.pdf\"}"
        ])

        let result = BridgePolicy.validate(action: action)
        XCTAssertFalse(result.allowed)
    }

    func testUnknownOpenAppReturnsNoopStatus() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"1","method":"ui.performAction","params":{"actionKind":"ui.open_app","target":"discovery","text":"open some totally unknown app","argsJson":"{\\"text\\":\\"open some totally unknown app\\"}"}}
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
        let screenshotRef = result?["screenshotRef"] as? String
        let recentEvents = result?["recentEvents"] as? [[String: Any]]

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

        XCTAssertEqual(result?["protocolVersion"] as? Int, 2)
        XCTAssertNotNil(result?["supportedActions"])
        XCTAssertNotNil(result?["observationModes"])
    }

    func testHotkeyWithoutArgsReturnsNoop() {
        let service = BridgeService()
        let request = """
        {"jsonrpc":"2.0","id":"3","method":"ui.performAction","params":{"actionKind":"ui.hotkey","argsJson":"{}"}}
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
        {"jsonrpc":"2.0","id":"5","method":"ui.performAction","params":{"actionKind":"ui.open_app","target":"discovery","text":"open NotRealChatApp","argsJson":"{\\"text\\":\\"open NotRealChatApp\\"}"}}
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
            "actionKind": actionKind,
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
