import Foundation

@MainActor
final class StandardInputPump {
    private let service = BridgeService()
    private let standardInput = FileHandle.standardInput
    private var buffer = Data()

    func start() {
        standardInput.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            Task { @MainActor [weak self] in
                self?.consume(chunk: chunk, from: handle)
            }
        }

        RunLoop.main.run()
    }

    private func consume(chunk: Data, from handle: FileHandle) {
        if chunk.isEmpty {
            handle.readabilityHandler = nil
            CFRunLoopStop(CFRunLoopGetMain())
            return
        }

        buffer.append(chunk)
        while let newlineRange = buffer.firstRange(of: Data([0x0a])) {
            let lineData = buffer.subdata(in: 0..<newlineRange.lowerBound)
            buffer.removeSubrange(0..<newlineRange.upperBound)

            guard let line = String(data: lineData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  line.isEmpty == false else {
                continue
            }

            let response = service.handle(line: line)
            FileHandle.standardOutput.write(Data((response + "\n").utf8))
        }
    }
}

let pump = StandardInputPump()
pump.start()
