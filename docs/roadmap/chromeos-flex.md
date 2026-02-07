# ChromeOS Flex Support

**Status:** Roadmap
**Priority:** Low effort, nice-to-have
**Audience:** ChromeOS Flex users (no ARC / Play Store)

---

## The Gap

ChromeOS Flex runs on regular PCs and has Chrome + Crostini (Linux container), but **no ARC** — so the Android companion app isn't available. Today these users have no supported path to use JSTorrent.

The Chrome extension provides the UI and engine, but it needs an I/O backend for sockets and file access. On regular ChromeOS that's the Android companion. On desktop that's the Rust native host. On ChromeOS Flex, neither is available out of the box.

## Solution: io-daemon in Crostini

Crostini gives us a full Linux environment. The io-daemon binary already supports standalone mode (direct WebSocket, no native messaging). We just need to make installation trivial.

### One-liner install

```bash
curl -sSL https://jstorrent.com/install-crostini.sh | bash
```

The script:
1. Downloads the `io-daemon` Linux binary from GitHub Releases
2. Places it in `~/.local/bin/`
3. Creates a systemd user service (`~/.config/systemd/user/jstorrent-io.service`)
4. Enables lingering (`loginctl enable-linger $USER`) so the service survives terminal close
5. Starts the service

### systemd service

```ini
[Unit]
Description=JSTorrent I/O Daemon

[Service]
ExecStart=%h/.local/bin/jstorrent-io-daemon --standalone
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

With `enable-linger`, the user service manager starts at boot (when Crostini is running) without needing an active terminal session.

### Extension integration

The extension detects ChromeOS Flex (ChromeOS without ARC) and shows a setup card:
- One-liner install command to copy
- Connection status indicator (daemon reachable or not)
- "Start Crostini" hint if the daemon isn't reachable

## Known Limitation

Crostini itself must be running. After a full reboot, the container doesn't auto-start — the user has to open the Terminal app or any Linux app once. This is an OS-level constraint. The extension can detect this and prompt accordingly.

## Effort

Minimal — the io-daemon binary and standalone WebSocket mode already exist. New work is just the install script and extension detection/UI for the setup flow.
