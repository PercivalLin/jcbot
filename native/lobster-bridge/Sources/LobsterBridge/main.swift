import Foundation

let service = BridgeService()
while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
        continue
    }
    let response = service.handle(line: trimmed)
    FileHandle.standardOutput.write(Data((response + "\n").utf8))
}
