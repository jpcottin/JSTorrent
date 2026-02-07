//! Integration test for the native messaging protocol between
//! the Tauri backend (or any host) and jstorrent-host (system-bridge).
//!
//! Prerequisites: both binaries must be built:
//!   `cargo build -p jstorrent-host -p jstorrent-io-daemon`
//!
//! Run:
//!   `cargo test -p jstorrent-host --test native_messaging`

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn write_native_message(stdin: &mut impl Write, msg: &serde_json::Value) {
    let json = serde_json::to_vec(msg).unwrap();
    let len = (json.len() as u32).to_le_bytes();
    stdin.write_all(&len).unwrap();
    stdin.write_all(&json).unwrap();
    stdin.flush().unwrap();
}

fn read_native_message(stdout: &mut impl Read) -> serde_json::Value {
    let mut len_buf = [0u8; 4];
    stdout.read_exact(&mut len_buf).unwrap();
    let len = u32::from_le_bytes(len_buf) as usize;
    assert!(len < 10 * 1024 * 1024, "Message too large: {len} bytes");
    let mut buf = vec![0u8; len];
    stdout.read_exact(&mut buf).unwrap();
    serde_json::from_slice(&buf).unwrap()
}

/// Wait for child to exit with a timeout. Returns true if exited.
fn wait_with_timeout(child: &mut std::process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn test_host_bridge_handshake() {
    let host_bin = env!("CARGO_BIN_EXE_jstorrent-host");

    // Check io-daemon exists (sibling binary, different package)
    let host_dir = std::path::Path::new(host_bin).parent().unwrap();
    let daemon_name = if cfg!(windows) {
        "jstorrent-io-daemon.exe"
    } else {
        "jstorrent-io-daemon"
    };
    let daemon_bin = host_dir.join(daemon_name);
    assert!(
        daemon_bin.exists(),
        "jstorrent-io-daemon not found at {}. Build it first:\n  cargo build -p jstorrent-io-daemon",
        daemon_bin.display()
    );

    let mut child = Command::new(host_bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn jstorrent-host");

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();

    // 1. Send Handshake
    let handshake = serde_json::json!({
        "id": "test-handshake",
        "op": "handshake",
        "extensionId": "tauri-integration-test",
        "installId": "test-install-id",
    });
    write_native_message(&mut stdin, &handshake);

    // 2. Read response
    let response = read_native_message(&mut stdout);

    assert_eq!(response["id"], "test-handshake", "response id must match");
    assert_eq!(response["ok"], true, "handshake must succeed: {response}");
    assert_eq!(
        response["type"], "DaemonInfo",
        "response type must be DaemonInfo"
    );

    let payload = &response["payload"];
    let port = payload["port"].as_u64().expect("port must be a number");
    assert!(port > 0, "port must be > 0");
    let token = payload["token"].as_str().expect("token must be a string");
    assert!(!token.is_empty(), "token must not be empty");
    let version = payload["version"]
        .as_str()
        .expect("version must be a string");
    assert!(!version.is_empty(), "version must not be empty");

    eprintln!("Handshake OK: port={port}, version={version}");

    // 3. Send a second request to validate framing (deleteDownloadRoot with nonexistent key)
    let delete_req = serde_json::json!({
        "id": "test-delete",
        "op": "deleteDownloadRoot",
        "key": "nonexistent-key",
    });
    write_native_message(&mut stdin, &delete_req);

    let delete_response = read_native_message(&mut stdout);
    assert_eq!(
        delete_response["id"], "test-delete",
        "response id must match"
    );
    // Response may be ok or error depending on implementation; we just validate framing works
    eprintln!("Delete response: ok={}", delete_response["ok"]);

    // 4. Close stdin -> system-bridge should exit cleanly (EOF shutdown)
    drop(stdin);

    if !wait_with_timeout(&mut child, Duration::from_secs(10)) {
        child.kill().ok();
        panic!("system-bridge did not exit within 10 seconds after stdin close");
    }

    eprintln!("system-bridge exited cleanly after stdin EOF");
}
