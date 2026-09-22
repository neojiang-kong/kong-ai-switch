// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KongAISwitch",
    platforms: [.macOS(.v13)],
    targets: [
        // All logic lives here so it can be exercised by a plain executable.
        // `swift test` needs XCTest, which ships inside Xcode.app; this machine
        // has Command Line Tools only, so the check runner below stands in for it.
        .target(name: "KongAISwitchCore", path: "Sources/KongAISwitchCore"),

        // The menu bar app.
        .executableTarget(
            name: "KongAISwitch",
            dependencies: ["KongAISwitchCore"],
            path: "Sources/KongAISwitch"
        ),

        // Self-checking executable: `swift run KongAISwitchChecks`.
        .executableTarget(
            name: "KongAISwitchChecks",
            dependencies: ["KongAISwitchCore"],
            path: "Sources/KongAISwitchChecks"
        ),
    ]
)
