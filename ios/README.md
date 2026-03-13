# iOS Scaffold

This directory contains the initial iOS scaffold for JSTorrent.

Generate the Xcode project:

```sh
xcodegen generate --spec ios/project.yml
```

Run the local Swift package tests:

```sh
swift test --package-path ios/JSTorrentKit
```

Refresh the bundled engine file after rebuilding `@jstorrent/engine`:

```sh
ios/scripts/sync-engine-bundle.sh
```

Until the real engine bundle is copied from `packages/engine/dist/engine.native.js`,
`ios/JSTorrent/Resources/engine.bundle.js` remains a placeholder stub.
