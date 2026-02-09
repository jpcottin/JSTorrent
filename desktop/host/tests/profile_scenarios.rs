//! E2E integration tests for the profile system.
//!
//! These tests spawn real `jstorrent-host` + `jstorrent-io-daemon` processes
//! and exercise profile scenarios via the native messaging protocol.
//!
//! Prerequisites: both binaries must be built:
//!   `cargo build -p jstorrent-host -p jstorrent-io-daemon`
//!
//! Run:
//!   `cargo test -p jstorrent-host --test profile_scenarios`

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!(
        "test-req-{}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// HostProcess wrapper
// ---------------------------------------------------------------------------

struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    #[allow(dead_code)]
    stderr: ChildStderr,
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Native messaging helpers (same protocol as native_messaging.rs)
// ---------------------------------------------------------------------------

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

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> bool {
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

// ---------------------------------------------------------------------------
// Spawn / shutdown helpers
// ---------------------------------------------------------------------------

fn assert_daemon_binary_exists() {
    let host_bin = env!("CARGO_BIN_EXE_jstorrent-host");
    let host_dir = Path::new(host_bin).parent().unwrap();
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
}

fn spawn_host(config_dir: &Path) -> HostProcess {
    let host_bin = env!("CARGO_BIN_EXE_jstorrent-host");
    let mut child = Command::new(host_bin)
        .env("JSTORRENT_CONFIG_DIR", config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn jstorrent-host");

    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    HostProcess {
        child,
        stdin: Some(stdin),
        stdout,
        stderr,
    }
}

fn shutdown_host(mut host: HostProcess) {
    // Close stdin → triggers EOF → host exits
    host.stdin.take();
    if !wait_with_timeout(&mut host.child, Duration::from_secs(10)) {
        host.child.kill().ok();
        panic!("host did not exit within 10 seconds after stdin close");
    }
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

fn handshake(
    host: &mut HostProcess,
    extension_id: &str,
    profile_id: Option<&str>,
) -> serde_json::Value {
    let mut msg = serde_json::json!({
        "id": next_id(),
        "op": "handshake",
        "extensionId": extension_id,
    });
    if let Some(pid) = profile_id {
        msg["profileId"] = serde_json::Value::String(pid.to_string());
    }
    write_native_message(host.stdin.as_mut().unwrap(), &msg);
    read_native_message(&mut host.stdout)
}

fn takeover(host: &mut HostProcess, extension_id: &str, profile_id: &str) -> serde_json::Value {
    let msg = serde_json::json!({
        "id": next_id(),
        "op": "takeOver",
        "extensionId": extension_id,
        "profileId": profile_id,
    });
    write_native_message(host.stdin.as_mut().unwrap(), &msg);
    read_native_message(&mut host.stdout)
}

fn kv_set(host: &mut HostProcess, key: &str, value: &str) -> serde_json::Value {
    let msg = serde_json::json!({
        "id": next_id(),
        "op": "kvSet",
        "key": key,
        "value": value,
    });
    write_native_message(host.stdin.as_mut().unwrap(), &msg);
    read_native_message(&mut host.stdout)
}

fn kv_get(host: &mut HostProcess, key: &str) -> serde_json::Value {
    let msg = serde_json::json!({
        "id": next_id(),
        "op": "kvGet",
        "key": key,
    });
    write_native_message(host.stdin.as_mut().unwrap(), &msg);
    read_native_message(&mut host.stdout)
}

// ---------------------------------------------------------------------------
// Assertion / utility helpers
// ---------------------------------------------------------------------------

/// Validate a DaemonInfo response and return (profile_id, daemon_port, daemon_token).
fn assert_daemon_info(response: &serde_json::Value) -> (String, u16, String) {
    assert_eq!(response["ok"], true, "response must be ok: {response}");
    assert_eq!(
        response["type"], "DaemonInfo",
        "response type must be DaemonInfo: {response}"
    );

    let payload = &response["payload"];
    let profile_id = payload["profileId"]
        .as_str()
        .expect("profileId must be present")
        .to_string();
    assert!(!profile_id.is_empty(), "profileId must not be empty");

    let port = payload["port"].as_u64().expect("port must be a number") as u16;
    assert!(port > 0, "port must be > 0");

    let token = payload["token"]
        .as_str()
        .expect("token must be a string")
        .to_string();
    assert!(!token.is_empty(), "token must not be empty");

    (profile_id, port, token)
}

/// Hit the daemon's /health endpoint (no auth required).
fn check_daemon_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    match client.get(&url).send() {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Read rpc-info.json from the test config directory.
fn read_rpc_info(config_dir: &Path) -> serde_json::Value {
    let rpc_file = config_dir.join("jstorrent-native").join("rpc-info.json");
    let contents = std::fs::read_to_string(&rpc_file)
        .unwrap_or_else(|e| panic!("Failed to read {}: {e}", rpc_file.display()));
    serde_json::from_str(&contents).unwrap()
}

// ===========================================================================
// Tests
// ===========================================================================

/// profile_id: None → creates a new profile with a valid UUID.
#[test]
fn test_fresh_profile_creation() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    let mut host = spawn_host(config_dir.path());
    let response = handshake(&mut host, "ext-fresh-test", None);
    let (profile_id, daemon_port, _) = assert_daemon_info(&response);

    // Profile ID should be UUID format (36 chars with dashes)
    assert_eq!(profile_id.len(), 36, "profileId should be UUID format");
    assert!(profile_id.contains('-'), "profileId should be a UUID");

    // Daemon should be running
    assert!(
        check_daemon_health(daemon_port),
        "daemon should respond to health check"
    );

    // Verify rpc-info.json has the profile
    let rpc_info = read_rpc_info(config_dir.path());
    let profiles = rpc_info["profiles"]
        .as_array()
        .expect("profiles should be array");
    let profile = profiles
        .iter()
        .find(|p| p["profile_id"].as_str() == Some(profile_id.as_str()))
        .expect("should find profile in rpc-info.json");
    assert!(profile["pid"].as_u64().unwrap() > 0);

    shutdown_host(host);
}

/// Passing an explicit profile_id from a previous session → reuses the same profile.
#[test]
fn test_profile_reuse_by_profile_id() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    // Host A: create profile
    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-reuse-test", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);
    shutdown_host(host_a);

    std::thread::sleep(Duration::from_millis(500));

    // Host B: pass A's profile_id explicitly → should reuse it
    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-reuse-test", Some(&profile_id_a));
    let (profile_id_b, _, _) = assert_daemon_info(&response_b);

    assert_eq!(
        profile_id_a, profile_id_b,
        "explicit profile_id should reuse the same profile"
    );

    shutdown_host(host_b);
}

/// Two hosts with no profile_id → each gets a separate new profile,
/// even with the same extension_id.
#[test]
fn test_no_profile_id_always_creates_new() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-same", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);
    shutdown_host(host_a);

    std::thread::sleep(Duration::from_millis(500));

    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-same", None);
    let (profile_id_b, _, _) = assert_daemon_info(&response_b);

    assert_ne!(
        profile_id_a, profile_id_b,
        "two handshakes with profile_id: None should create different profiles"
    );

    shutdown_host(host_b);
}

/// Host A active with profile. Host B sends same profile_id → ProfileInUse.
#[test]
fn test_profile_in_use_detection() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    // Host A: create and hold profile
    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-in-use-a", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);

    // Verify host A's RPC health endpoint works
    let rpc_info = read_rpc_info(config_dir.path());
    let host_a_entry = rpc_info["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["profile_id"].as_str().unwrap() == profile_id_a)
        .expect("should find host A's profile entry");
    let host_a_rpc_port = host_a_entry["port"].as_u64().unwrap() as u16;
    let host_a_rpc_token = host_a_entry["token"].as_str().unwrap();

    let health_url = format!("http://127.0.0.1:{host_a_rpc_port}/health?token={host_a_rpc_token}");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let health_resp = client
        .get(&health_url)
        .send()
        .expect("health check should succeed");
    assert!(
        health_resp.status().is_success(),
        "host A RPC health check should succeed"
    );

    // Host B: explicitly request A's profile → ProfileInUse
    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-in-use-b", Some(&profile_id_a));

    assert_eq!(response_b["ok"], false, "should be error: {response_b}");
    assert_eq!(
        response_b["error"].as_str().unwrap(),
        "profile_in_use",
        "error should be profile_in_use: {response_b}"
    );
    assert_eq!(
        response_b["type"], "ProfileInUse",
        "type should be ProfileInUse: {response_b}"
    );

    let payload_b = &response_b["payload"];
    assert_eq!(
        payload_b["profileId"].as_str().unwrap(),
        profile_id_a,
        "ProfileInUse should reference A's profileId"
    );
    assert!(
        payload_b["pid"].as_u64().unwrap() > 0,
        "ProfileInUse should have incumbent PID"
    );

    shutdown_host(host_b);
    shutdown_host(host_a);
}

/// Host A crashes (stale entry). Host B passes A's profile_id → takes over.
#[test]
fn test_stale_process_takeover() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    // Host A: create profile
    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-stale-test", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);

    // Kill host A (simulates crash — leaves stale entry in rpc-info.json)
    host_a.child.kill().ok();
    let _ = host_a.child.wait();

    // Wait for daemon to notice parent death
    std::thread::sleep(Duration::from_secs(2));

    // Host B: pass A's profile_id → stale PID is dead → takes over
    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-stale-test", Some(&profile_id_a));
    let (profile_id_b, daemon_port_b, _) = assert_daemon_info(&response_b);

    assert_eq!(
        profile_id_a, profile_id_b,
        "should reuse same profile after stale process takeover"
    );
    assert!(
        check_daemon_health(daemon_port_b),
        "new daemon should be healthy"
    );

    shutdown_host(host_b);
}

/// Host B sends TakeOver with A's profile_id → kills A, takes profile.
#[test]
fn test_explicit_takeover() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    // Host A: create and hold profile
    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-takeover-a", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);

    // Host B: TakeOver with A's profile_id → kills A, then handshakes
    let mut host_b = spawn_host(config_dir.path());
    let response_b = takeover(&mut host_b, "ext-takeover-b", &profile_id_a);
    let (profile_id_b, daemon_port_b, _) = assert_daemon_info(&response_b);

    assert_eq!(
        profile_id_a, profile_id_b,
        "should get same profile after takeover"
    );

    // Verify host A was killed
    std::thread::sleep(Duration::from_millis(200));
    let exit_status = host_a.child.try_wait().unwrap();
    assert!(
        exit_status.is_some(),
        "host A should have been killed by takeover"
    );

    assert!(
        check_daemon_health(daemon_port_b),
        "host B's daemon should be healthy"
    );

    shutdown_host(host_b);
}

/// Two hosts both send profile_id: None → two different profiles, two daemons.
#[test]
fn test_multiple_independent_profiles() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-multi-a", None);
    let (profile_id_a, daemon_port_a, _) = assert_daemon_info(&response_a);

    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-multi-b", None);
    let (profile_id_b, daemon_port_b, _) = assert_daemon_info(&response_b);

    assert_ne!(profile_id_a, profile_id_b, "should get different profiles");
    assert_ne!(
        daemon_port_a, daemon_port_b,
        "daemons should be on different ports"
    );

    assert!(
        check_daemon_health(daemon_port_a),
        "daemon A should be healthy"
    );
    assert!(
        check_daemon_health(daemon_port_b),
        "daemon B should be healthy"
    );

    // Verify rpc-info.json has both
    let rpc_info = read_rpc_info(config_dir.path());
    let profiles = rpc_info["profiles"].as_array().unwrap();
    assert!(profiles
        .iter()
        .any(|p| p["profile_id"].as_str() == Some(profile_id_a.as_str())));
    assert!(profiles
        .iter()
        .any(|p| p["profile_id"].as_str() == Some(profile_id_b.as_str())));

    shutdown_host(host_a);
    shutdown_host(host_b);
}

/// Explicit bad profile_id → error. Then handshake with None → creates new profile.
#[test]
fn test_invalid_profile_id() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    let mut host = spawn_host(config_dir.path());

    let response = handshake(
        &mut host,
        "ext-invalid-test",
        Some("nonexistent-uuid-12345"),
    );
    assert_eq!(
        response["ok"], false,
        "should fail for invalid profileId: {response}"
    );
    let error = response["error"].as_str().unwrap();
    assert!(
        error.contains("Invalid profile ID") || error.contains("not found"),
        "error should mention invalid profile: {error}"
    );

    // Host should still be alive — send a valid handshake
    let response2 = handshake(&mut host, "ext-invalid-test", None);
    assert_eq!(
        response2["ok"], true,
        "handshake with None should succeed: {response2}"
    );

    shutdown_host(host);
}

/// KV data is isolated per profile and persists across host restarts.
#[test]
fn test_per_profile_kv_isolation() {
    assert_daemon_binary_exists();
    let config_dir = tempfile::tempdir().unwrap();

    // Host A: create profile, set KV value
    let mut host_a = spawn_host(config_dir.path());
    let response_a = handshake(&mut host_a, "ext-kv-a", None);
    let (profile_id_a, _, _) = assert_daemon_info(&response_a);

    let set_resp = kv_set(&mut host_a, "setting", "hello");
    assert_eq!(set_resp["ok"], true, "KvSet should succeed: {set_resp}");

    let get_resp = kv_get(&mut host_a, "setting");
    assert_eq!(get_resp["ok"], true, "KvGet should succeed: {get_resp}");
    assert_eq!(get_resp["payload"]["value"].as_str().unwrap(), "hello");

    shutdown_host(host_a);
    std::thread::sleep(Duration::from_millis(500));

    // Host B: different profile (None) → should NOT see A's KV data
    let mut host_b = spawn_host(config_dir.path());
    let response_b = handshake(&mut host_b, "ext-kv-b", None);
    let (profile_id_b, _, _) = assert_daemon_info(&response_b);
    assert_ne!(profile_id_a, profile_id_b, "should be different profiles");

    let get_resp_b = kv_get(&mut host_b, "setting");
    assert_eq!(get_resp_b["ok"], true, "KvGet should succeed on host B");
    assert!(
        get_resp_b["payload"]["value"].is_null(),
        "different profile should not see A's KV data: {get_resp_b}"
    );

    shutdown_host(host_b);
    std::thread::sleep(Duration::from_millis(500));

    // Host C: reconnect to A's profile by profile_id → should see persisted KV data
    let mut host_c = spawn_host(config_dir.path());
    let response_c = handshake(&mut host_c, "ext-kv-c", Some(&profile_id_a));
    let (profile_id_c, _, _) = assert_daemon_info(&response_c);
    assert_eq!(profile_id_a, profile_id_c, "should reuse A's profile");

    let get_resp_c = kv_get(&mut host_c, "setting");
    assert_eq!(get_resp_c["ok"], true, "KvGet should succeed on host C");
    assert_eq!(
        get_resp_c["payload"]["value"].as_str().unwrap(),
        "hello",
        "should see A's persisted KV data"
    );

    shutdown_host(host_c);
}
