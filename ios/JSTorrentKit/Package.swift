// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "JSTorrentKit",
    platforms: [
        .iOS(.v16),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "JSTorrentKit",
            targets: ["JSTorrentKit"]
        )
    ],
    targets: [
        .target(
            name: "JSTorrentKit",
            path: "Sources"
        ),
        .testTarget(
            name: "JSTorrentKitTests",
            dependencies: ["JSTorrentKit"],
            path: "Tests/JSTorrentKitTests"
        )
    ]
)
