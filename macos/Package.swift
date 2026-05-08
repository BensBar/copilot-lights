// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CopilotLightsMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CopilotLightsMenuBar", targets: ["CopilotLightsMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "CopilotLightsMenuBar",
            dependencies: [],
            path: "Sources/CopilotLightsMenuBar",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "CopilotLightsMenuBarTests",
            dependencies: ["CopilotLightsMenuBar"],
            path: "Tests/CopilotLightsMenuBarTests"
        )
    ]
)
