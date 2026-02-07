//! Standalone mode support for Crostini/Linux users without native host.
//!
//! This module provides Android-compatible pairing endpoints that allow the
//! Chrome extension to connect to the daemon running in Crostini.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::AppState;

/// Config file for standalone mode, stored in ~/.config/jstorrent-standalone/
const CONFIG_DIR_NAME: &str = "jstorrent-standalone";
const CONFIG_FILE_NAME: &str = "config.json";

#[derive(Serialize, Deserialize, Default)]
pub struct StandaloneConfig {
    /// Authentication token (generated on first run)
    pub token: Option<String>,
    /// Paired extension ID
    pub extension_id: Option<String>,
    /// Paired install ID
    pub install_id: Option<String>,
}

impl StandaloneConfig {
    /// Load config from disk, or return default
    pub fn load() -> Self {
        if let Some(path) = Self::config_path() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str(&content) {
                    return config;
                }
            }
        }
        Self::default()
    }

    /// Save config to disk
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path().ok_or_else(|| anyhow::anyhow!("No config dir"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    fn config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME))
    }
}

// ============================================================================
// Request/Response types (matching Android companion server)
// ============================================================================

#[derive(Deserialize)]
pub struct StatusRequest {
    pub token: Option<String>,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub port: u16,
    pub paired: bool,
    pub extension_id: Option<String>,
    pub install_id: Option<String>,
    pub version: Option<String>,
    pub token_valid: Option<bool>,
    /// Capabilities for UI adaptation
    pub capabilities: Option<Capabilities>,
}

#[derive(Serialize)]
pub struct Capabilities {
    /// Whether download roots can be added/removed (false in standalone mode)
    pub roots_manageable: bool,
}

#[derive(Deserialize)]
pub struct PairRequest {
    pub token: String,
}

#[derive(Serialize)]
pub struct PairResponse {
    pub status: String, // "approved", "pending", "conflict"
}

#[derive(Serialize)]
pub struct RootsResponse {
    pub roots: Vec<jstorrent_common::DownloadRoot>,
}

// ============================================================================
// Extended state for standalone mode
// ============================================================================

/// Extended application state for standalone mode
pub struct StandaloneState {
    /// Base app state
    pub app: Arc<AppState>,
    /// Standalone config (for pairing persistence)
    pub config: std::sync::RwLock<StandaloneConfig>,
    /// Server port (for status response)
    pub port: u16,
}

// ============================================================================
// Routes
// ============================================================================

pub fn routes(standalone_state: Arc<StandaloneState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", post(status_handler))
        .route("/pair", post(pair_handler))
        .route("/roots", get(roots_handler))
        .with_state(standalone_state)
}

async fn status_handler(
    State(state): State<Arc<StandaloneState>>,
    body: Option<Json<StatusRequest>>,
) -> Json<StatusResponse> {
    let config = state.config.read().unwrap();

    // Check if provided token is valid
    let token_valid = body
        .as_ref()
        .and_then(|b| b.token.as_ref())
        .map(|t| config.token.as_ref() == Some(t));

    Json(StatusResponse {
        port: state.port,
        paired: config.token.is_some(),
        extension_id: config.extension_id.clone(),
        install_id: config.install_id.clone(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        token_valid,
        capabilities: Some(Capabilities {
            roots_manageable: false, // Standalone mode has fixed root
        }),
    })
}

async fn pair_handler(
    State(state): State<Arc<StandaloneState>>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Result<Json<PairResponse>, StatusCode> {
    // Extract extension headers from the request
    let extension_id = headers
        .get("X-JST-ExtensionId")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let install_id = headers
        .get("X-JST-InstallId")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Require valid extension ID header to prevent drive-by pairing from web pages
    // Chrome extension IDs are 32 lowercase letters a-p (base16 using a-p instead of 0-9a-f)
    let ext_id = match &extension_id {
        Some(id) if is_valid_extension_id(id) => id,
        _ => {
            tracing::warn!(
                "Standalone mode: rejected pairing - missing or invalid X-JST-ExtensionId header"
            );
            return Err(StatusCode::BAD_REQUEST);
        }
    };

    let mut config = state.config.write().unwrap();

    // Only allow pairing if not already paired (first-pairing-only security)
    // Use --reset-pairing flag to clear existing pairing and allow new one
    if config.token.is_some() {
        tracing::warn!(
            "Standalone mode: rejected pairing from {} - already paired. Use --reset-pairing to allow new pairing.",
            ext_id
        );
        return Err(StatusCode::CONFLICT);
    }

    // Store the token, extension_id, and install_id in config
    config.token = Some(request.token.clone());
    config.extension_id = extension_id.clone();
    config.install_id = install_id.clone();

    // Also update the AppState token so auth middleware uses the new token
    *state.app.token.write().unwrap() = request.token.clone();
    // Update extension_id in AppState as well
    *state.app.extension_id.write().unwrap() = extension_id.clone();

    // Save to disk
    if let Err(e) = config.save() {
        tracing::error!("Failed to save standalone config: {}", e);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    tracing::info!(
        "Standalone mode: auto-approved pairing for extension={}, install={:?}, token updated in AppState",
        ext_id,
        install_id
    );

    Json(PairResponse {
        status: "approved".to_string(),
    })
    .pipe(Ok)
}

/// Validate Chrome extension ID format (32 lowercase letters a-p)
fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_lowercase() && c >= 'a' && c <= 'p')
}

async fn roots_handler(
    State(state): State<Arc<StandaloneState>>,
) -> Json<RootsResponse> {
    let roots = state.app.download_roots.read().unwrap().clone();
    Json(RootsResponse { roots })
}

// Helper trait for pipe syntax
trait Pipe: Sized {
    fn pipe<F, R>(self, f: F) -> R
    where
        F: FnOnce(Self) -> R,
    {
        f(self)
    }
}

impl<T> Pipe for T {}

// ============================================================================
// Standalone mode initialization
// ============================================================================

/// Create a download root from a path
pub fn create_download_root(path: &std::path::Path) -> jstorrent_common::DownloadRoot {
    use sha2::{Digest, Sha256};

    let path_str = path.to_string_lossy().to_string();
    let display_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    // Generate key from path hash
    let mut hasher = Sha256::new();
    hasher.update(path_str.as_bytes());
    let hash = hasher.finalize();
    let key = format!("{:x}", hash).chars().take(16).collect();

    jstorrent_common::DownloadRoot {
        key,
        disk_id: jstorrent_common::get_disk_id(&path),
        path: path_str,
        display_name,
        removable: false,
        last_stat_ok: path.exists(),
        last_checked: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    }
}

/// Generate a random token for standalone mode
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}
