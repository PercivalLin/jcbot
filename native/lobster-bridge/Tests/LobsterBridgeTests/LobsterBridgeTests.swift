import XCTest
@testable import LobsterBridge

final class LobsterBridgeTests: XCTestCase {
    func testHardRedActionIsRejected() {
        let result = BridgePolicy.validate(actionKind: "external.send_message", approvalToken: "token")
        XCTAssertFalse(result.allowed)
    }

    func testYellowContactActionNeedsToken() {
        let result = BridgePolicy.validate(actionKind: "external.select_contact", approvalToken: nil)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionNeedsToken() {
        let result = BridgePolicy.validate(actionKind: "external.upload_file", approvalToken: nil)
        XCTAssertFalse(result.allowed)
    }

    func testYellowUploadActionAllowsWithToken() {
        let result = BridgePolicy.validate(actionKind: "external.upload_file", approvalToken: "token")
        XCTAssertTrue(result.allowed)
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

        XCTAssertNotNil(screenshotRef)
        XCTAssertTrue(screenshotRef?.hasPrefix("bridge://snapshot/") ?? false)
        XCTAssertNotNil(result?["candidates"])
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
        let request = """
        {"jsonrpc":"2.0","id":"6","method":"ui.performAction","params":{"actionKind":"external.select_contact","approvalToken":"token","argsJson":"{\\"searchLabelHints\\":\\"搜索\\"}"}}
        """

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
        let request = """
        {"jsonrpc":"2.0","id":"8","method":"ui.performAction","params":{"actionKind":"external.upload_file","approvalToken":"token","argsJson":"{}"}}
        """

        let response = service.handle(line: request)
        XCTAssertTrue(response.contains("noop:no-file-path"))
    }
}
