import XCTest
import JSTorrentKit

final class JSTorrentAppTests: XCTestCase {
    func testBootstrapConfigDefaultsToIOSPlatform() {
        let config = EngineBootstrapConfig(contentRoots: [])

        XCTAssertEqual(config.platformType, .iosStandalone)
    }
}
