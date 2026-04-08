// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LobsterBridge",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "lobster-bridge", targets: ["LobsterBridge"])
    ],
    targets: [
        .executableTarget(
            name: "LobsterBridge",
            path: "Sources/LobsterBridge"
        ),
        .testTarget(
            name: "LobsterBridgeTests",
            dependencies: ["LobsterBridge"],
            path: "Tests/LobsterBridgeTests"
        )
    ]
)

