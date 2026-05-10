// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CopilotLights",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CopilotLights", targets: ["CopilotLights"])
    ],
    targets: [
        .executableTarget(
            name: "CopilotLights",
            dependencies: [],
            path: "Sources/CopilotLights",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "CopilotLightsTests",
            dependencies: ["CopilotLights"],
            path: "Tests/CopilotLightsTests"
        )
    ]
)
