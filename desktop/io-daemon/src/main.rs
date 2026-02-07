use axum::{
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderName, Method,
    },
    routing::get,
    Router,
};

// Custom headers for file API
const X_PATH_BASE64: HeaderName = HeaderName::from_static("x-path-base64");
const X_OFFSET: HeaderName = HeaderName::from_static("x-offset");
const X_LENGTH: HeaderName = HeaderName::from_static("x-length");
const X_EXPECTED_SHA1: HeaderName = HeaderName::from_static("x-expected-sha1");
const X_SHA_REASON: HeaderName = HeaderName::from_static("x-sha-reason");
use clap::Parser;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::signal;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

mod auth;
mod config;
mod control;
mod files;
mod hashing;
mod http;
mod standalone;
mod ws;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Port to listen on (default: 0 for managed mode, 7800 for standalone)
    #[arg(short, long)]
    port: Option<u16>,

    /// Authentication token (required for managed mode, generated for standalone)
    #[arg(short, long)]
    token: Option<String>,

    /// Parent PID to monitor (managed mode only)
    #[arg(long)]
    parent_pid: Option<u32>,

    /// Installation ID (required for managed mode, defaults to "standalone")
    #[arg(long)]
    install_id: Option<String>,

    /// Run in standalone mode for Crostini/Linux without native host.
    /// Enables Android-compatible pairing endpoints at /status, /pair, /roots.
    /// Auto-approves pairing requests and uses CWD as download root.
    #[arg(long)]
    standalone: bool,

    /// Download root directory for standalone mode (defaults to current directory)
    #[arg(long)]
    download_root: Option<std::path::PathBuf>,

    /// Bind address (default: 127.0.0.1 for managed, 0.0.0.0 for standalone)
    #[arg(long)]
    bind: Option<String>,

    /// Clear existing pairing and allow a new extension to pair (standalone mode only)
    #[arg(long)]
    reset_pairing: bool,
}

/// Live daemon statistics for debugging
#[derive(Default)]
pub struct DaemonStats {
    /// Number of active TCP sockets
    pub tcp_sockets: AtomicU32,
    /// Number of pending TCP connections (not yet established)
    pub pending_connects: AtomicU32,
    /// Number of pending TCP streams (connected but not activated)
    pub pending_tcp: AtomicU32,
    /// Number of active UDP sockets
    pub udp_sockets: AtomicU32,
    /// Number of active TCP servers (listeners)
    pub tcp_servers: AtomicU32,
    /// Number of active WebSocket connections
    pub ws_connections: AtomicU32,
    /// Total bytes sent via TCP/UDP
    pub bytes_sent: AtomicU64,
    /// Total bytes received via TCP/UDP
    pub bytes_received: AtomicU64,
    /// Daemon start time (epoch seconds)
    pub start_time: AtomicU64,
}

impl DaemonStats {
    pub fn new() -> Self {
        let stats = Self::default();
        stats.start_time.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            Ordering::Relaxed,
        );
        stats
    }
}

#[derive(Clone)]
pub struct AppState {
    pub token: Arc<std::sync::RwLock<String>>,
    pub install_id: String,
    pub extension_id: Arc<std::sync::RwLock<Option<String>>>,
    pub download_roots: Arc<std::sync::RwLock<Vec<jstorrent_common::DownloadRoot>>>,
    pub stats: Arc<DaemonStats>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Set up logging to both stderr and file
    let log_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let file_appender = tracing_appender::rolling::never(&log_dir, "io-daemon.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    // Default to INFO level, but allow override via RUST_LOG env var
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .init();

    tracing::info!(
        "io-daemon starting, logging to {:?}",
        log_dir.join("io-daemon.log")
    );

    // Log binary mtime to help diagnose stale binary issues
    if let Ok(exe_path) = std::env::current_exe() {
        if let Ok(metadata) = std::fs::metadata(&exe_path) {
            if let Ok(mtime) = metadata.modified() {
                let datetime: chrono::DateTime<chrono::Local> = mtime.into();
                tracing::info!(
                    "binary: {:?}, mtime: {}",
                    exe_path,
                    datetime.format("%Y-%m-%d %H:%M:%S")
                );
            }
        }
    }

    let args = Args::parse();

    // Determine mode and set defaults
    let is_standalone = args.standalone;

    if is_standalone {
        run_standalone(args).await
    } else {
        run_managed(args).await
    }
}

/// Run in managed mode (launched by native host)
async fn run_managed(args: Args) -> anyhow::Result<()> {
    // In managed mode, token and install_id are required
    let token = args
        .token
        .ok_or_else(|| anyhow::anyhow!("--token is required in managed mode"))?;
    let install_id = args
        .install_id
        .ok_or_else(|| anyhow::anyhow!("--install-id is required in managed mode"))?;
    let port = args.port.unwrap_or(0);
    let bind_addr = args.bind.as_deref().unwrap_or("127.0.0.1");

    // Load initial config from rpc-info.json
    let (roots, extension_id) = config::load_config(&install_id).map_or_else(
        |e| {
            tracing::warn!("Failed to load initial config: {}", e);
            (Vec::new(), None)
        },
        |c| (c.download_roots, c.extension_id),
    );

    let state = Arc::new(AppState {
        token: Arc::new(std::sync::RwLock::new(token.clone())),
        install_id: install_id.clone(),
        extension_id: Arc::new(std::sync::RwLock::new(extension_id.clone())),
        download_roots: Arc::new(std::sync::RwLock::new(roots)),
        stats: Arc::new(DaemonStats::new()),
    });

    // Monitor parent process if specified
    if let Some(pid) = args.parent_pid {
        tokio::spawn(async move {
            monitor_parent(pid).await;
        });
    }

    let cors = build_cors_layer(extension_id.as_deref(), false);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(files::routes())
        .merge(hashing::routes())
        .merge(ws::routes())
        .merge(control::routes())
        .merge(config::routes())
        .merge(http::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::middleware,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state.clone());

    let addr: SocketAddr = format!("{bind_addr}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    // Print the bound port to stdout so the parent can read it
    println!("{}", local_addr.port());

    tracing::info!("listening on {}", local_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Run in standalone mode (for Crostini/Linux without native host)
async fn run_standalone(args: Args) -> anyhow::Result<()> {
    use standalone::{StandaloneConfig, StandaloneState};

    let port = args.port.unwrap_or(7800);
    let bind_addr = args.bind.as_deref().unwrap_or("0.0.0.0");
    let install_id = args.install_id.unwrap_or_else(|| "standalone".to_string());

    // Determine download root
    let download_root_path = args.download_root.unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    });
    let download_root_path = download_root_path
        .canonicalize()
        .unwrap_or(download_root_path);

    tracing::info!("Standalone mode: download root = {:?}", download_root_path);

    // Create download root entry
    let root = standalone::create_download_root(&download_root_path);
    let roots = vec![root];

    // Load or create standalone config
    let mut standalone_config = StandaloneConfig::load();

    // Handle --reset-pairing flag
    if args.reset_pairing {
        tracing::info!("Standalone mode: clearing existing pairing (--reset-pairing)");
        standalone_config.token = None;
        standalone_config.extension_id = None;
        standalone_config.install_id = None;
        if let Err(e) = standalone_config.save() {
            tracing::warn!("Failed to save standalone config: {}", e);
        }
        eprintln!("Pairing reset. A new extension can now pair.");
    }

    // Get existing token or leave as None (will be set on first pairing)
    let token = standalone_config.token.clone().unwrap_or_default();
    let is_paired = !token.is_empty();

    tracing::info!("Standalone mode: paired = {}", is_paired);
    eprintln!("\n=== JSTorrent IO Daemon (Standalone Mode) ===");
    eprintln!("Download root: {}", download_root_path.display());
    if is_paired {
        eprintln!(
            "Status: Paired with extension {}",
            standalone_config
                .extension_id
                .as_deref()
                .unwrap_or("unknown")
        );
    } else {
        eprintln!("Status: Waiting for extension to pair...");
    }
    eprintln!("Listening on: {bind_addr}:{port}");
    eprintln!("\nThe Chrome extension will auto-discover this daemon.");
    eprintln!("================================================\n");

    let state = Arc::new(AppState {
        token: Arc::new(std::sync::RwLock::new(token.clone())),
        install_id: install_id.clone(),
        extension_id: Arc::new(std::sync::RwLock::new(
            standalone_config.extension_id.clone(),
        )),
        download_roots: Arc::new(std::sync::RwLock::new(roots)),
        stats: Arc::new(DaemonStats::new()),
    });

    // Create standalone state for pairing endpoints
    let standalone_state = Arc::new(StandaloneState {
        app: state.clone(),
        config: std::sync::RwLock::new(standalone_config),
        port,
    });

    // In standalone mode, allow any origin (extension origin is dynamic)
    let cors = build_cors_layer(None, true);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(standalone::routes(standalone_state))
        .merge(files::routes())
        .merge(hashing::routes())
        .merge(ws::routes())
        .merge(control::routes())
        .merge(http::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::standalone_middleware,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state.clone());

    let addr: SocketAddr = format!("{bind_addr}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    tracing::info!("Standalone mode: listening on {}", local_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Build CORS layer with appropriate origins
fn build_cors_layer(extension_id: Option<&str>, allow_any: bool) -> CorsLayer {
    let allowed_headers = [
        CONTENT_TYPE,
        AUTHORIZATION,
        HeaderName::from_static("x-jst-auth"),
        HeaderName::from_static("x-jst-extensionid"),
        HeaderName::from_static("x-jst-installid"),
        X_PATH_BASE64,
        X_OFFSET,
        X_LENGTH,
        X_EXPECTED_SHA1,
        X_SHA_REASON,
    ];

    if allow_any {
        tracing::info!("CORS: Allowing any origin (standalone mode)");
        return CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(allowed_headers)
            .max_age(Duration::from_secs(86400));
    }

    let mut allowed_origins: Vec<axum::http::HeaderValue> = vec![];

    // Add Chrome extension origin if available, or Tauri origins for desktop app
    if let Some(ext_id) = extension_id {
        if ext_id.starts_with("tauri") {
            // Tauri desktop app: add webview origins for all platforms
            for origin in &[
                "tauri://localhost",       // macOS/Linux production
                "https://tauri.localhost", // Windows production
                "http://localhost:1420",   // Tauri dev server (Vite)
            ] {
                tracing::info!("CORS: Adding Tauri origin: {}", origin);
                if let Ok(val) = origin.parse() {
                    allowed_origins.push(val);
                }
            }
        } else {
            let origin = format!("chrome-extension://{ext_id}");
            tracing::info!("CORS: Adding extension origin: {}", origin);
            if let Ok(val) = origin.parse() {
                allowed_origins.push(val);
            }
        }
    }

    // Add production website origins
    for origin in &["https://new.jstorrent.com", "https://jstorrent.com"] {
        tracing::info!("CORS: Adding production origin: {}", origin);
        if let Ok(val) = origin.parse() {
            allowed_origins.push(val);
        }
    }

    // Add dev origins from environment
    if let Ok(dev_origins) = std::env::var("JSTORRENT_DEV_ORIGINS") {
        for origin in dev_origins.split(',') {
            let origin = origin.trim();
            if !origin.is_empty() {
                tracing::info!("CORS: Adding dev origin: {}", origin);
                if let Ok(val) = origin.parse() {
                    allowed_origins.push(val);
                }
            }
        }
    }

    if allowed_origins.is_empty() {
        tracing::warn!("CORS: No origins configured, allowing any origin");
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(allowed_headers)
            .max_age(Duration::from_secs(86400))
    } else {
        CorsLayer::new()
            .allow_origin(allowed_origins)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers(allowed_headers)
            .max_age(Duration::from_secs(86400))
    }
}

#[cfg(unix)]
async fn monitor_parent(pid: u32) {
    use std::process::Command;
    use tokio::time::{sleep, Duration};

    loop {
        sleep(Duration::from_secs(1)).await;

        let output = Command::new("kill").arg("-0").arg(pid.to_string()).output();

        if let Ok(output) = output {
            if !output.status.success() {
                tracing::info!("Parent process {} exited, shutting down", pid);
                std::process::exit(0);
            }
        } else {
            tracing::warn!("Failed to check parent process, shutting down");
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
async fn monitor_parent(pid: u32) {
    use tokio::time::{sleep, Duration};
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    loop {
        sleep(Duration::from_secs(1)).await;

        // HANDLE is isize in windows-sys, 0 means failure
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle == 0 {
            tracing::info!("Parent process {} no longer exists, shutting down", pid);
            std::process::exit(0);
        }

        let mut exit_code: u32 = 0;
        let success = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
        unsafe { CloseHandle(handle) };

        if success == 0 {
            tracing::warn!("Failed to get parent process exit code, shutting down");
            std::process::exit(1);
        }

        if exit_code != STILL_ACTIVE as u32 {
            tracing::info!(
                "Parent process {} exited with code {}, shutting down",
                pid,
                exit_code
            );
            std::process::exit(0);
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!("signal received, starting graceful shutdown");
}
