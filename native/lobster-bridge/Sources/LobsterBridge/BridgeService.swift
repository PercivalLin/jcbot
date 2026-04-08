import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

final class BridgeService {
    private static let defaultKnownApplications = [
        "Finder",
        "Safari",
        "Google Chrome",
        "Terminal",
        "iTerm2",
        "Mail",
        "Calendar",
        "Notes",
        "Preview",
        "Xcode",
        "Visual Studio Code"
    ]
    private static let applicationAliases: [String: String] = [
        "Chrome": "Google Chrome",
        "VS Code": "Visual Studio Code",
        "微信": "WeChat",
        "Weixin": "WeChat",
        "weixin": "WeChat"
    ]

    private var knownApplications = BridgeService.defaultKnownApplications

    func handle(line: String) -> String {
        do {
            let request = try JSONDecoder().decode(JsonRpcRequest.self, from: Data(line.utf8))
            do {
                switch request.method {
                case "health.ping":
                    return encode(id: request.id, result: ["ok": "true"])
                case "bridge.describeCapabilities":
                    return encode(id: request.id, result: currentCapabilities())
                case "bridge.configureKnownApplications":
                    let updatedCount = configureKnownApplications(request.params)
                    return encode(id: request.id, result: [
                        "ok": "true",
                        "count": "\(updatedCount)"
                    ])
                case "bridge.searchApplications":
                    let query = request.params?["query"] ?? ""
                    let matches = searchApplications(query: query)
                    return encode(id: request.id, result: matches)
                case "policy.validateAction":
                    let actionKind = request.params?["actionKind"] ?? ""
                    let approvalToken = request.params?["approvalToken"]
                    let result = BridgePolicy.validate(actionKind: actionKind, approvalToken: approvalToken)
                    return encode(id: request.id, result: result)
                case "observation.snapshot":
                    let snapshot = buildSnapshot()
                    return encode(id: request.id, result: snapshot)
                case "ui.performAction":
                    let action = ActionRequest(params: request.params)
                    let validation = BridgePolicy.validate(actionKind: action.actionKind, approvalToken: action.approvalToken)
                    if validation.allowed == false {
                        return encode(id: request.id, error: JsonRpcError(code: -32010, message: validation.reason))
                    }
                    let result = try performAction(action)
                    return encode(id: request.id, result: result)
                default:
                    return encode(id: request.id, error: JsonRpcError(code: -32601, message: "Unknown method \(request.method)"))
                }
            } catch let error as BridgeRuntimeError {
                return encode(id: request.id, error: JsonRpcError(code: error.code, message: error.localizedDescription))
            } catch {
                return encode(id: request.id, error: JsonRpcError(code: -32099, message: error.localizedDescription))
            }
        } catch {
            return encode(id: "unknown", error: JsonRpcError(code: -32700, message: "Parse error: \(error.localizedDescription)"))
        }
    }

    private func encode<Result: Codable>(id: String, result: Result) -> String {
        let response = JsonRpcResponse(jsonrpc: "2.0", id: id, result: result, error: nil as JsonRpcError?)
        let data = try! JSONEncoder().encode(response)
        return String(decoding: data, as: UTF8.self)
    }

    private func encode(id: String, error: JsonRpcError) -> String {
        let response = JsonRpcResponse<EmptyRpcResult>(jsonrpc: "2.0", id: id, result: nil, error: error)
        let data = try! JSONEncoder().encode(response)
        return String(decoding: data, as: UTF8.self)
    }

    private func currentCapabilities() -> BridgeCapabilities {
        BridgeCapabilities(
            accessibility: AXIsProcessTrusted(),
            screenCapture: CGPreflightScreenCaptureAccess(),
            eventTap: true,
            ocr: false,
            policyHardGate: true
        )
    }

    private func buildSnapshot() -> SnapshotResult {
        let activeApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"
        let windows = visibleWindows()
        let candidates = accessibilityCandidates()
        let activeWindowTitle = windows.first(where: { $0.ownerName == activeApp && !$0.title.isEmpty })?.title
        let note = "Observed \(windows.count) on-screen windows and \(candidates.count) accessibility candidates."

        return SnapshotResult(
            screenshotRef: "bridge://snapshot/\(ISO8601DateFormatter().string(from: Date()))",
            activeApp: activeApp,
            activeWindowTitle: activeWindowTitle,
            note: note,
            windows: windows.map { descriptor in
                descriptor.title.isEmpty ? descriptor.ownerName : "\(descriptor.ownerName): \(descriptor.title)"
            },
            candidates: candidates.map(\.candidate)
        )
    }

    private func visibleWindows(limit: Int = 12) -> [WindowDescriptor] {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }

        return raw.compactMap { entry in
            let ownerName = entry[kCGWindowOwnerName as String] as? String ?? "Unknown"
            let title = entry[kCGWindowName as String] as? String ?? ""
            let layer = entry[kCGWindowLayer as String] as? Int ?? 0
            let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1.0
            let ownerPID = entry[kCGWindowOwnerPID as String] as? Int32 ?? 0

            guard layer == 0, alpha > 0, ownerPID != 0 else {
                return nil
            }

            if ownerName == "Window Server" || ownerName == "Control Center" {
                return nil
            }

            return WindowDescriptor(ownerName: ownerName, title: title)
        }
        .prefix(limit)
        .map { $0 }
    }

    private func performAction(_ action: ActionRequest) throws -> PerformActionResult {
        switch action.actionKind {
        case "ui.open_app":
            let applicationName = resolveApplicationName(action)
            guard let applicationName else {
                return PerformActionResult(status: "noop:no-app-match")
            }

            let opened = try openApplication(named: applicationName)
            return PerformActionResult(status: opened ? "opened:\(applicationName)" : "failed:\(applicationName)")
        case "ui.activate_app":
            let applicationName = resolveApplicationName(action)
            guard let applicationName else {
                return PerformActionResult(status: "noop:no-app-match")
            }

            let activated = try activateApplication(named: applicationName)
            return PerformActionResult(status: activated ? "activated:\(applicationName)" : "failed:\(applicationName)")
        case "ui.focus_target":
            guard let label = resolveTargetLabel(action) else {
                return PerformActionResult(status: "noop:no-target-label")
            }
            let targetRole = resolveTargetRole(action)

            try focusTarget(matching: label, preferredRole: targetRole)
            return PerformActionResult(status: "focused-target:\(label)")
        case "ui.type_into_target":
            guard let label = resolveTargetLabel(action) else {
                return PerformActionResult(status: "noop:no-target-label")
            }
            let targetRole = resolveTargetRole(action)

            let text = resolveText(action)
            guard text.isEmpty == false else {
                return PerformActionResult(status: "noop:no-text")
            }

            try typeIntoTarget(label: label, text: text, preferredRole: targetRole)
            return PerformActionResult(status: "typed-into-target:\(label):\(text.count)")
        case "external.select_contact":
            return try selectContact(action)
        case "external.upload_file", "upload_file":
            return try uploadFile(action)
        case "ui.type_text", "type_text", "ui.paste_text", "paste_text":
            let text = resolveText(action)
            guard text.isEmpty == false else {
                return PerformActionResult(status: "noop:no-text")
            }

            try typeText(text)
            return PerformActionResult(status: "typed:\(text.count)")
        case "ui.click", "click":
            if let point = resolvePointIfPresent(action) {
                try click(at: point)
                return PerformActionResult(status: "clicked:\(Int(point.x)),\(Int(point.y))")
            }

            guard let label = resolveTargetLabel(action) else {
                throw BridgeRuntimeError(code: -32030, message: "Click action requires either numeric coordinates or a target label.")
            }
            let targetRole = resolveTargetRole(action)

            try clickTarget(matching: label, preferredRole: targetRole)
            return PerformActionResult(status: "clicked-target:\(label)")
        case "ui.double_click", "double_click":
            if let point = resolvePointIfPresent(action) {
                try click(at: point, clickCount: 2)
                return PerformActionResult(status: "double-clicked:\(Int(point.x)),\(Int(point.y))")
            }

            guard let label = resolveTargetLabel(action) else {
                throw BridgeRuntimeError(code: -32030, message: "Double-click action requires either numeric coordinates or a target label.")
            }
            let targetRole = resolveTargetRole(action)

            try clickTarget(matching: label, preferredRole: targetRole, clickCount: 2)
            return PerformActionResult(status: "double-clicked-target:\(label)")
        case "ui.click_target":
            guard let label = resolveTargetLabel(action) else {
                return PerformActionResult(status: "noop:no-target-label")
            }
            let targetRole = resolveTargetRole(action)

            try clickTarget(matching: label, preferredRole: targetRole)
            return PerformActionResult(status: "clicked-target:\(label)")
        case "ui.scroll", "scroll":
            let scroll = resolveScrollVector(action)
            guard scroll.deltaX != 0 || scroll.deltaY != 0 else {
                return PerformActionResult(status: "noop:no-scroll-delta")
            }

            try scrollBy(deltaX: scroll.deltaX, deltaY: scroll.deltaY)
            return PerformActionResult(status: "scrolled:\(scroll.direction):\(scroll.deltaX),\(scroll.deltaY)")
        case "ui.hotkey", "hotkey":
            guard let hotkey = resolveHotkey(action) else {
                return PerformActionResult(status: "noop:no-hotkey")
            }

            try triggerHotkey(hotkey)
            return PerformActionResult(status: "hotkey:\(hotkey.normalized)")
        case "ui.navigate", "ui.inspect", "ui.read":
            return PerformActionResult(status: "noop:\(action.actionKind)")
        default:
            return PerformActionResult(status: "stubbed:\(action.actionKind)")
        }
    }

    private func resolveApplicationName(_ action: ActionRequest) -> String? {
        let directTarget = action.target?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let directTarget, !directTarget.isEmpty, directTarget != "discovery", directTarget != "pending-target", directTarget != "pending-contact" {
            return canonicalApplicationName(directTarget)
        }

        let explicitText = action.args["app"] ?? action.args["application"] ?? action.args["text"] ?? action.text ?? ""
        let matched = knownApplications.first { candidate in
            explicitText.localizedCaseInsensitiveContains(candidate)
        }

        if let matched {
            return canonicalApplicationName(matched)
        }

        let aliasMatched = BridgeService.applicationAliases.first { alias, _ in
            explicitText.localizedCaseInsensitiveContains(alias)
        }
        return aliasMatched?.value
    }

    private func configureKnownApplications(_ params: [String: String]?) -> Int {
        guard let appsJson = params?["appsJson"],
              let data = appsJson.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
            knownApplications = BridgeService.defaultKnownApplications
            return knownApplications.count
        }

        var configured = BridgeService.defaultKnownApplications
        configured.append(contentsOf: parsed.compactMap { element in
            let value = String(describing: element).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : canonicalApplicationName(value)
        })

        knownApplications = dedupeApplications(configured)
        return knownApplications.count
    }

    private func canonicalApplicationName(_ raw: String) -> String {
        BridgeService.applicationAliases[raw] ??
            BridgeService.applicationAliases.first(where: { alias, _ in
                alias.compare(raw, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
            })?.value ??
            raw
    }

    private func dedupeApplications(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []

        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }

            let key = trimmed.lowercased()
            if seen.contains(key) {
                continue
            }

            seen.insert(key)
            result.append(trimmed)
        }

        return result
    }

    private func searchApplications(query: String, limit: Int = 8) -> [String] {
        let normalizedQuery = normalize(query)
        var candidates = knownApplications
        candidates.append(contentsOf: installedApplications())
        let deduped = dedupeApplications(candidates)

        if normalizedQuery.isEmpty {
            return Array(deduped.prefix(limit))
        }

        let queryTokens = normalizedQuery
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .map(String.init)
            .filter { $0.isEmpty == false }

        let scored: [(name: String, score: Int)] = deduped.compactMap { appName in
            let normalizedName = normalize(appName)
            var score = 0

            if normalizedName == normalizedQuery {
                score = 140
            } else if normalizedName.contains(normalizedQuery) {
                score = 100
            } else if normalizedQuery.contains(normalizedName) {
                score = 70
            } else {
                for token in queryTokens where token.isEmpty == false {
                    if normalizedName.contains(token) {
                        score += 20
                    }
                }
            }

            guard score > 0 else {
                return nil
            }

            return (name: appName, score: score)
        }
        .sorted { left, right in
            if left.score != right.score {
                return left.score > right.score
            }

            return left.name < right.name
        }

        return Array(scored.prefix(limit).map(\.name))
    }

    private func installedApplications(scanDepth: Int = 2, maxCount: Int = 400) -> [String] {
        let fileManager = FileManager.default
        let roots = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Applications/Utilities",
            "\(NSHomeDirectory())/Applications"
        ];

        var queue: [(url: URL, depth: Int)] = roots.map { (URL(fileURLWithPath: $0), 0) }
        var discovered: [String] = []

        while queue.isEmpty == false {
            let (root, depth) = queue.removeFirst()
            guard let entries = try? fileManager.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else {
                continue
            }

            for entry in entries {
                if entry.pathExtension.lowercased() == "app" {
                    let appName = entry.deletingPathExtension().lastPathComponent
                    if appName.isEmpty == false {
                        discovered.append(appName)
                    }

                    if discovered.count >= maxCount {
                        return dedupeApplications(discovered)
                    }
                    continue
                }

                guard depth < scanDepth else {
                    continue
                }

                var isDirectory: ObjCBool = false
                if fileManager.fileExists(atPath: entry.path, isDirectory: &isDirectory), isDirectory.boolValue {
                    queue.append((entry, depth + 1))
                }
            }
        }

        return dedupeApplications(discovered)
    }

    private func openApplication(named applicationName: String) throws -> Bool {
        guard let fullPath = NSWorkspace.shared.fullPath(forApplication: applicationName) else {
            return false
        }

        let url = URL(fileURLWithPath: fullPath)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        var launchError: Error?
        var didOpen = false
        let semaphore = DispatchSemaphore(value: 0)

        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            launchError = error
            didOpen = error == nil
            semaphore.signal()
        }

        _ = semaphore.wait(timeout: .now() + 5)

        if let launchError {
            throw launchError
        }

        return didOpen
    }

    private func activateApplication(named applicationName: String) throws -> Bool {
        guard let fullPath = NSWorkspace.shared.fullPath(forApplication: applicationName) else {
            return false
        }

        let url = URL(fileURLWithPath: fullPath)
        if let bundleIdentifier = Bundle(url: url)?.bundleIdentifier,
           let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first {
            return running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }

        return try openApplication(named: applicationName)
    }

    private func resolveText(_ action: ActionRequest) -> String {
        let candidates = [
            action.args["text"],
            action.text,
            action.args["value"],
            action.args["message"]
        ]

        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { $0.isEmpty == false }) ?? ""
    }

    private func resolvePoint(_ action: ActionRequest) throws -> CGPoint {
        guard let point = resolvePointIfPresent(action) else {
            throw BridgeRuntimeError(code: -32030, message: "Click action requires numeric x and y coordinates.")
        }

        return point
    }

    private func resolvePointIfPresent(_ action: ActionRequest) -> CGPoint? {
        let xValue = action.args["x"] ?? action.args["clientX"] ?? action.args["screenX"]
        let yValue = action.args["y"] ?? action.args["clientY"] ?? action.args["screenY"]

        guard let xString = xValue, let yString = yValue, let x = Double(xString), let y = Double(yString) else {
            return nil
        }

        return CGPoint(x: x, y: y)
    }

    private func resolveTargetLabel(_ action: ActionRequest) -> String? {
        let candidates = [
            action.args["label"],
            action.args["targetLabel"],
            action.target,
            action.text
        ]

        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty && $0 != "discovery" && $0 != "pending-target" && $0 != "pending-contact" })
    }

    private func resolveTargetRole(_ action: ActionRequest) -> String? {
        let candidates = [
            action.args["role"],
            action.args["targetRole"],
            action.args["candidateRole"]
        ]

        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
    }

    private func resolveContactName(_ action: ActionRequest) -> String? {
        let placeholders = Set(["pending-contact", "pending-target", "discovery", "active-window"])
        let candidates = [
            action.args["contact"],
            action.args["targetContact"],
            action.target
        ]

        for candidate in candidates {
            guard let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  value.isEmpty == false else {
                continue
            }

            if placeholders.contains(value.lowercased()) {
                continue
            }

            return value
        }

        return nil
    }

    private func resolveUploadFilePath(_ action: ActionRequest) -> String? {
        let placeholders = Set(["pending-file", "pending-target", "discovery"])
        let candidates = [
            action.args["filePath"],
            action.args["path"],
            action.args["file"],
            action.args["sourcePath"],
            action.target
        ]

        for candidate in candidates {
            guard let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  value.isEmpty == false else {
                continue
            }

            if placeholders.contains(value.lowercased()) {
                continue
            }

            return value
        }

        return nil
    }

    private func resolveHintList(_ raw: String?, fallback: [String]) -> [String] {
        guard let raw, raw.isEmpty == false else {
            return fallback
        }

        var values: [String] = []
        let delimiters = CharacterSet(charactersIn: ",;|/")
        for token in raw.components(separatedBy: delimiters) {
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty == false {
                values.append(trimmed)
            }
        }

        if values.isEmpty {
            return fallback
        }

        return dedupeCaseInsensitive(values)
    }

    private func dedupeCaseInsensitive(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []

        for value in values {
            let key = value.lowercased()
            if seen.contains(key) {
                continue
            }

            seen.insert(key)
            result.append(value)
        }

        return result
    }

    private func resolveScrollVector(_ action: ActionRequest) -> (direction: String, deltaX: Int32, deltaY: Int32) {
        let explicitDeltaX = parseSignedInt32(action.args["deltaX"] ?? action.args["dx"] ?? action.args["x"])
        let explicitDeltaY = parseSignedInt32(action.args["deltaY"] ?? action.args["dy"] ?? action.args["y"])
        if let explicitDeltaX, let explicitDeltaY {
            return ("custom", explicitDeltaX, explicitDeltaY)
        }

        let directionHint = (
            action.args["direction"] ??
            action.args["scrollDirection"] ??
            action.text ??
            ""
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()

        let parsedAmount = parseSignedInt32(
            action.args["amount"] ??
            action.args["delta"] ??
            action.args["distance"] ??
            action.args["step"]
        ) ?? 320
        let amount = Int32(min(max(abs(Int(parsedAmount)), 40), 2000))

        if directionHint.contains("up") || directionHint.contains("向上") || directionHint.contains("上滑") {
            return ("up", 0, amount)
        }

        if directionHint.contains("left") || directionHint.contains("向左") || directionHint.contains("左滑") {
            return ("left", -amount, 0)
        }

        if directionHint.contains("right") || directionHint.contains("向右") || directionHint.contains("右滑") {
            return ("right", amount, 0)
        }

        return ("down", 0, -amount)
    }

    private func parseSignedInt32(_ value: String?) -> Int32? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.isEmpty == false,
              let parsed = Double(value) else {
            return nil
        }

        return Int32(parsed.rounded())
    }

    private func resolveHotkey(_ action: ActionRequest) -> HotkeyChord? {
        let candidates = [
            action.args["keys"],
            action.args["hotkey"],
            action.args["key"],
            action.text
        ]

        for candidate in candidates {
            guard let candidate, candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                continue
            }

            if let parsed = parseHotkey(candidate) {
                return parsed
            }
        }

        return nil
    }

    private func parseHotkey(_ raw: String) -> HotkeyChord? {
        let normalizedRaw = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "快捷键", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "hotkey", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "press", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "按下", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "按", with: "", options: .caseInsensitive)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard normalizedRaw.isEmpty == false else {
            return nil
        }

        let components = normalizedRaw.contains("+")
            ? normalizedRaw.split(separator: "+")
            : normalizedRaw.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })

        var modifiers: [String] = []
        var primary: String?

        for component in components {
            guard let token = normalizeHotkeyToken(String(component)) else {
                continue
            }

            switch token {
            case "cmd", "ctrl", "alt", "shift":
                if modifiers.contains(token) == false {
                    modifiers.append(token)
                }
            default:
                primary = token
            }
        }

        if primary == nil, components.count == 1 {
            primary = normalizeHotkeyToken(normalizedRaw)
        }

        guard let primary,
              let keyCode = keyCode(for: primary) else {
            return nil
        }

        let modifierFlags = flags(for: modifiers)
        let normalizedChord = (modifiers + [primary]).joined(separator: "+")
        return HotkeyChord(
            keyCode: keyCode,
            modifiers: modifierFlags,
            normalized: normalizedChord
        )
    }

    private func normalizeHotkeyToken(_ raw: String) -> String? {
        let token = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,:;，。[](){}"))
        guard token.isEmpty == false else {
            return nil
        }

        if ["⌘", "cmd", "command", "meta"].contains(token) {
            return "cmd"
        }

        if ["ctrl", "control", "^"].contains(token) || token.contains("控制") {
            return "ctrl"
        }

        if ["alt", "option", "opt", "⌥"].contains(token) || token.contains("选项") {
            return "alt"
        }

        if ["shift", "⇧"].contains(token) {
            return "shift"
        }

        if ["return", "enter"].contains(token) || token.contains("回车") || token.contains("确认") {
            return "enter"
        }

        if ["esc", "escape"].contains(token) {
            return "esc"
        }

        if ["tab", "space"].contains(token) || token.contains("空格") {
            return token.contains("空格") ? "space" : token
        }

        if ["up", "down", "left", "right"].contains(token) ||
            token.contains("上箭头") || token.contains("下箭头") || token.contains("左箭头") || token.contains("右箭头") {
            if token.contains("up") || token.contains("上箭头") {
                return "up"
            }
            if token.contains("down") || token.contains("下箭头") {
                return "down"
            }
            if token.contains("left") || token.contains("左箭头") {
                return "left"
            }
            if token.contains("right") || token.contains("右箭头") {
                return "right"
            }
        }

        if ["delete", "backspace"].contains(token) || token.contains("删除") || token.contains("退格") {
            return token.contains("退格") ? "backspace" : token
        }

        if token.count == 1, token.range(of: "^[a-z0-9]$", options: .regularExpression) != nil {
            return token
        }

        return nil
    }

    private func keyCode(for token: String) -> CGKeyCode? {
        switch token {
        case "a": return 0
        case "s": return 1
        case "d": return 2
        case "f": return 3
        case "h": return 4
        case "g": return 5
        case "z": return 6
        case "x": return 7
        case "c": return 8
        case "v": return 9
        case "b": return 11
        case "q": return 12
        case "w": return 13
        case "e": return 14
        case "r": return 15
        case "y": return 16
        case "t": return 17
        case "1": return 18
        case "2": return 19
        case "3": return 20
        case "4": return 21
        case "6": return 22
        case "5": return 23
        case "9": return 25
        case "7": return 26
        case "8": return 28
        case "0": return 29
        case "o": return 31
        case "u": return 32
        case "i": return 34
        case "p": return 35
        case "l": return 37
        case "j": return 38
        case "k": return 40
        case "n": return 45
        case "m": return 46
        case "enter", "return": return 36
        case "tab": return 48
        case "space": return 49
        case "delete", "backspace": return 51
        case "esc": return 53
        case "left": return 123
        case "right": return 124
        case "down": return 125
        case "up": return 126
        default:
            return nil
        }
    }

    private func flags(for modifierTokens: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for token in modifierTokens {
            switch token {
            case "cmd":
                flags.insert(.maskCommand)
            case "ctrl":
                flags.insert(.maskControl)
            case "alt":
                flags.insert(.maskAlternate)
            case "shift":
                flags.insert(.maskShift)
            default:
                continue
            }
        }

        return flags
    }

    private func selectContact(_ action: ActionRequest) throws -> PerformActionResult {
        guard let contact = resolveContactName(action) else {
            return PerformActionResult(status: "noop:no-contact")
        }

        if let appName = resolveApplicationName(action) {
            _ = try activateApplication(named: appName)
        }

        let searchHints = resolveHintList(
            action.args["searchLabelHints"] ?? action.args["searchLabels"] ?? action.args["searchHints"],
            fallback: ["Search", "搜索", "联系人", "Contact"]
        )

        if AXIsProcessTrusted() {
            if let searchField = resolveFirstTargetElement(matchingAny: searchHints, preferredRole: "text field") {
                try focus(
                    element: searchField.element,
                    preferredLabel: searchField.candidate.label,
                    fallbackBounds: searchField.candidate.bounds
                )
                if setValue(contact, on: searchField.element) == false {
                    try typeText(contact)
                }
            } else {
                try typeText(contact)
            }

            if let contactMatch = resolveFirstTargetElement(matchingAny: [contact], preferredRole: nil) {
                if AXUIElementPerformAction(contactMatch.element, kAXPressAction as CFString) != .success,
                   let bounds = contactMatch.candidate.bounds {
                    let center = CGPoint(x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2)
                    try click(at: center)
                }
            } else if let enter = parseHotkey("enter") {
                try triggerHotkey(enter)
            }
        } else {
            try typeText(contact)
            if let enter = parseHotkey("enter") {
                try triggerHotkey(enter)
            }
        }

        return PerformActionResult(status: "selected-contact:\(contact)")
    }

    private func uploadFile(_ action: ActionRequest) throws -> PerformActionResult {
        guard let rawPath = resolveUploadFilePath(action) else {
            return PerformActionResult(status: "noop:no-file-path")
        }

        let filePath = normalizeLocalPath(rawPath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: filePath, isDirectory: &isDirectory), isDirectory.boolValue == false else {
            return PerformActionResult(status: "noop:file-not-found:\(filePath)")
        }

        if let appName = resolveApplicationName(action) {
            _ = try? activateApplication(named: appName)
        }

        let attachmentHints = resolveHintList(
            action.args["attachmentLabelHints"] ?? action.args["attachmentHints"] ?? action.args["attachLabels"],
            fallback: ["Attach", "附件", "Upload", "上传", "+"]
        )
        if AXIsProcessTrusted(),
           let attachmentTarget = resolveFirstTargetElement(matchingAny: attachmentHints, preferredRole: "button") {
            if AXUIElementPerformAction(attachmentTarget.element, kAXPressAction as CFString) != .success,
               let bounds = attachmentTarget.candidate.bounds {
                let center = CGPoint(x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2)
                try click(at: center)
            }
            usleep(120_000)
        }

        guard isLikelyFilePickerVisible() else {
            return PerformActionResult(status: "noop:file-picker-not-ready")
        }

        if let goToFolder = parseHotkey("cmd+shift+g") {
            try? triggerHotkey(goToFolder)
            usleep(120_000)
        }

        try typeText(filePath)
        if let enter = parseHotkey("enter") {
            try triggerHotkey(enter)
            usleep(120_000)
            try triggerHotkey(enter)
        }

        let fileName = URL(fileURLWithPath: filePath).lastPathComponent
        return PerformActionResult(status: "uploaded-file:\(fileName)")
    }

    private func normalizeLocalPath(_ rawPath: String) -> String {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let expanded = (trimmed as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return expanded
        }

        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(expanded)
            .path
    }

    private func isLikelyFilePickerVisible() -> Bool {
        let keywords = [
            "open",
            "choose",
            "upload",
            "attach",
            "file",
            "folder",
            "打开",
            "选择",
            "上传",
            "附件",
            "文件",
            "目录",
            "前往文件夹"
        ]

        let windows = visibleWindows(limit: 20)
        for window in windows {
            let combined = "\(window.ownerName) \(window.title)"
            if containsKeyword(combined, keywords: keywords) {
                return true
            }
        }

        if AXIsProcessTrusted() {
            for candidate in accessibilityCandidates(limit: 30, maxDepth: 4) {
                if containsKeyword(candidate.candidate.label, keywords: keywords) {
                    return true
                }
            }
        }

        return false
    }

    private func containsKeyword(_ value: String, keywords: [String]) -> Bool {
        let normalizedValue = normalize(value).lowercased()
        if normalizedValue.isEmpty {
            return false
        }

        return keywords.contains { keyword in
            normalizedValue.contains(normalize(keyword).lowercased())
        }
    }

    private func typeText(_ text: String) throws {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw BridgeRuntimeError(code: -32031, message: "Unable to create keyboard event source.")
        }

        let scalars = Array(text.utf16)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw BridgeRuntimeError(code: -32032, message: "Unable to construct keyboard events.")
        }

        keyDown.keyboardSetUnicodeString(stringLength: scalars.count, unicodeString: scalars)
        keyUp.keyboardSetUnicodeString(stringLength: scalars.count, unicodeString: scalars)
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    private func triggerHotkey(_ hotkey: HotkeyChord) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: hotkey.keyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: hotkey.keyCode, keyDown: false) else {
            throw BridgeRuntimeError(code: -32039, message: "Unable to construct hotkey events.")
        }

        keyDown.flags = hotkey.modifiers
        keyUp.flags = hotkey.modifiers
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    private func scrollBy(deltaX: Int32, deltaY: Int32) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let scroll = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 2,
                wheel1: deltaY,
                wheel2: deltaX,
                wheel3: 0
              ) else {
            throw BridgeRuntimeError(code: -32040, message: "Unable to construct scroll events.")
        }

        scroll.post(tap: .cghidEventTap)
    }

    private func click(at point: CGPoint, clickCount: Int = 1) throws {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw BridgeRuntimeError(code: -32033, message: "Unable to create mouse event source.")
        }

        for index in 1...clickCount {
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
                  let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw BridgeRuntimeError(code: -32034, message: "Unable to construct mouse events.")
            }

            move.post(tap: .cghidEventTap)
            down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(50_000)
        }
    }

    private func clickTarget(matching label: String, preferredRole: String? = nil, clickCount: Int = 1) throws {
        guard AXIsProcessTrusted() else {
            throw BridgeRuntimeError(code: -32035, message: "Accessibility permission is required for target-based clicking.")
        }

        let match = try resolveTargetElement(matching: label, preferredRole: preferredRole)

        if AXUIElementPerformAction(match.element, kAXPressAction as CFString) == .success {
            return
        }

        if let bounds = match.candidate.bounds {
            let center = CGPoint(x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2)
            try click(at: center, clickCount: clickCount)
            return
        }

        throw BridgeRuntimeError(code: -32037, message: "Matched target '\(label)' but could not perform a press action.")
    }

    private func focusTarget(matching label: String, preferredRole: String? = nil) throws {
        let match = try resolveTargetElement(matching: label, preferredRole: preferredRole)
        try focus(element: match.element, preferredLabel: label, fallbackBounds: match.candidate.bounds)
    }

    private func typeIntoTarget(label: String, text: String, preferredRole: String? = nil) throws {
        let match = try resolveTargetElement(matching: label, preferredRole: preferredRole)
        try focus(element: match.element, preferredLabel: label, fallbackBounds: match.candidate.bounds)

        if setValue(text, on: match.element) {
            return
        }

        try typeText(text)
    }

    private func accessibilityCandidates(limit: Int = 24, maxDepth: Int = 4) -> [ResolvedAccessibilityElement] {
        guard AXIsProcessTrusted(),
              let app = NSWorkspace.shared.frontmostApplication else {
            return []
        }

        let applicationElement = AXUIElementCreateApplication(app.processIdentifier)
        let roots = copyElementArray(from: applicationElement, attribute: kAXWindowsAttribute as CFString)
        let seedElements = roots.isEmpty ? [applicationElement] : roots

        var results: [ResolvedAccessibilityElement] = []
        for root in seedElements {
            collectAccessibilityCandidates(
                from: root,
                depth: 0,
                maxDepth: maxDepth,
                limit: limit,
                results: &results
            )

            if results.count >= limit {
                break
            }
        }

        return results
    }

    private func collectAccessibilityCandidates(
        from element: AXUIElement,
        depth: Int,
        maxDepth: Int,
        limit: Int,
        results: inout [ResolvedAccessibilityElement]
    ) {
        guard results.count < limit, depth <= maxDepth else {
            return
        }

        if let candidate = snapshotCandidate(for: element, fallbackId: results.count) {
            results.append(ResolvedAccessibilityElement(element: element, candidate: candidate))
        }

        guard depth < maxDepth else {
            return
        }

        let children = copyElementArray(from: element, attribute: kAXChildrenAttribute as CFString)
        for child in children {
            collectAccessibilityCandidates(from: child, depth: depth + 1, maxDepth: maxDepth, limit: limit, results: &results)
            if results.count >= limit {
                break
            }
        }
    }

    private func snapshotCandidate(for element: AXUIElement, fallbackId: Int) -> SnapshotCandidate? {
        let role = copyStringValue(from: element, attribute: kAXRoleAttribute as CFString) ?? "AXUnknown"
        let label = resolvedAccessibilityLabel(for: element)
        let value = resolvedAccessibilityValue(for: element)
        let focused = resolvedFocusedState(for: element)
        let roleDescription = copyStringValue(from: element, attribute: kAXRoleDescriptionAttribute as CFString) ?? role
        let normalizedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard normalizedLabel.isEmpty == false || role.hasPrefix("AXButton") || role.hasPrefix("AXTextField") || role.hasPrefix("AXLink") else {
            return nil
        }

        return SnapshotCandidate(
            id: "ax-\(fallbackId)",
            role: roleDescription,
            label: normalizedLabel.isEmpty ? roleDescription : normalizedLabel,
            value: value,
            focused: focused,
            bounds: copyBounds(from: element),
            confidence: 0.9,
            source: "ax"
        )
    }

    private func resolvedAccessibilityLabel(for element: AXUIElement) -> String? {
        let candidates = [
            copyStringValue(from: element, attribute: kAXTitleAttribute as CFString),
            copyStringValue(from: element, attribute: kAXDescriptionAttribute as CFString),
            copyStringValue(from: element, attribute: "AXPlaceholderValue" as CFString),
            copyStringValue(from: element, attribute: kAXRoleDescriptionAttribute as CFString)
        ]

        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { $0.isEmpty == false })
    }

    private func resolvedAccessibilityValue(for element: AXUIElement) -> String? {
        let value = copyStringValue(from: element, attribute: kAXValueAttribute as CFString)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let value, value.isEmpty == false else {
            return nil
        }

        return value
    }

    private func resolvedFocusedState(for element: AXUIElement) -> Bool? {
        guard let value = copyAttributeValue(from: element, attribute: kAXFocusedAttribute as CFString) else {
            return nil
        }

        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((value as! CFBoolean))
        }

        return nil
    }

    private func copyStringValue(from element: AXUIElement, attribute: CFString) -> String? {
        guard let value = copyAttributeValue(from: element, attribute: attribute) else {
            return nil
        }

        if CFGetTypeID(value) == CFStringGetTypeID() {
            return value as? String
        }

        return nil
    }

    private func copyBounds(from element: AXUIElement) -> SnapshotBounds? {
        guard let positionRaw = copyAttributeValue(from: element, attribute: kAXPositionAttribute as CFString),
              let sizeRaw = copyAttributeValue(from: element, attribute: kAXSizeAttribute as CFString) else {
            return nil
        }

        guard CFGetTypeID(positionRaw) == AXValueGetTypeID(),
              CFGetTypeID(sizeRaw) == AXValueGetTypeID() else {
            return nil
        }

        let positionValue = positionRaw as! AXValue
        let sizeValue = sizeRaw as! AXValue

        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point),
              AXValueGetValue(sizeValue, .cgSize, &size) else {
            return nil
        }

        return SnapshotBounds(
            x: point.x,
            y: point.y,
            width: size.width,
            height: size.height
        )
    }

    private func copyAttributeValue(from element: AXUIElement, attribute: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard error == .success else {
            return nil
        }
        return value
    }

    private func copyElementArray(from element: AXUIElement, attribute: CFString) -> [AXUIElement] {
        guard let value = copyAttributeValue(from: element, attribute: attribute) else {
            return []
        }

        if CFGetTypeID(value) != CFArrayGetTypeID() {
            return []
        }

        if let elements = value as? [AXUIElement] {
            return elements
        }

        return []
    }

    private func bestCandidateMatch(
        for label: String,
        in candidates: [ResolvedAccessibilityElement],
        preferredRole: String?
    ) -> ResolvedAccessibilityElement? {
        let normalizedTarget = normalize(label)
        let normalizedRole = preferredRole.map(normalizeRole)
        var scored: [(candidate: ResolvedAccessibilityElement, score: Int)] = []

        for candidate in candidates {
            let candidateLabel = normalize(candidate.candidate.label)
            var score = 0

            if candidateLabel == normalizedTarget {
                score += 120
            } else if candidateLabel.contains(normalizedTarget) || normalizedTarget.contains(candidateLabel) {
                score += 70
            } else {
                continue
            }

            if let normalizedRole {
                if roleMatches(candidateRole: normalizeRole(candidate.candidate.role), preferredRole: normalizedRole) {
                    score += 35
                }
            }

            if candidate.candidate.focused == true {
                score += 15
            }

            score += Int(candidate.candidate.confidence * 10)
            scored.append((candidate: candidate, score: score))
        }

        return scored.max(by: { $0.score < $1.score })?.candidate
    }

    private func resolveFirstTargetElement(
        matchingAny labels: [String],
        preferredRole: String?
    ) -> ResolvedAccessibilityElement? {
        guard AXIsProcessTrusted() else {
            return nil
        }

        let candidates = accessibilityCandidates(limit: 40, maxDepth: 5)
        for label in labels {
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                continue
            }

            if let match = bestCandidateMatch(for: trimmed, in: candidates, preferredRole: preferredRole) {
                return match
            }
        }

        return nil
    }

    private func resolveTargetElement(matching label: String, preferredRole: String? = nil) throws -> ResolvedAccessibilityElement {
        guard AXIsProcessTrusted() else {
            throw BridgeRuntimeError(code: -32035, message: "Accessibility permission is required for target-based actions.")
        }

        let candidates = accessibilityCandidates(limit: 40, maxDepth: 5)
        guard let match = bestCandidateMatch(for: label, in: candidates, preferredRole: preferredRole) else {
            if let preferredRole {
                throw BridgeRuntimeError(code: -32036, message: "No accessibility target matched '\(label)' with role '\(preferredRole)'.")
            }

            throw BridgeRuntimeError(code: -32036, message: "No accessibility target matched '\(label)'.")
        }

        return match
    }

    private func focus(element: AXUIElement, preferredLabel: String, fallbackBounds: SnapshotBounds?) throws {
        if isAttributeSettable(kAXFocusedAttribute as CFString, on: element),
           AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
            return
        }

        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return
        }

        if let bounds = fallbackBounds {
            let center = CGPoint(x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2)
            try click(at: center)
            return
        }

        throw BridgeRuntimeError(code: -32038, message: "Unable to focus target '\(preferredLabel)'.")
    }

    private func setValue(_ text: String, on element: AXUIElement) -> Bool {
        guard isAttributeSettable(kAXValueAttribute as CFString, on: element) else {
            return false
        }

        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
        return result == .success
    }

    private func isAttributeSettable(_ attribute: CFString, on element: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute, &settable)
        return result == .success && settable.boolValue
    }

    private func normalize(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    private func normalizeRole(_ value: String) -> String {
        normalize(value)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
    }

    private func roleMatches(candidateRole: String, preferredRole: String) -> Bool {
        candidateRole == preferredRole ||
            candidateRole.contains(preferredRole) ||
            preferredRole.contains(candidateRole)
    }
}

private struct BridgeRuntimeError: LocalizedError {
    let code: Int
    let message: String

    var errorDescription: String? {
        message
    }
}

private struct EmptyRpcResult: Codable {}

private struct ResolvedAccessibilityElement {
    let element: AXUIElement
    let candidate: SnapshotCandidate
}

private struct HotkeyChord {
    let keyCode: CGKeyCode
    let modifiers: CGEventFlags
    let normalized: String
}
