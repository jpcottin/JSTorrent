use crate::{files::validate_path, AppState};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, PRAGMA,
        },
        HeaderMap, Method, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
    net::TcpListener,
};
use tokio_util::io::ReaderStream;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS: u64 = 12 * 60 * 60 * 1000;

#[derive(Default)]
pub struct MediaServerState {
    pub port: Option<u16>,
}

#[derive(Clone)]
pub struct RegisteredHttpStream {
    pub token: String,
    pub torrent_id: String,
    pub root_key: String,
    pub path: String,
    #[allow(dead_code)]
    pub file_size: u64,
    pub mime_type: Option<String>,
    #[allow(dead_code)]
    pub created_at_ms: u64,
    pub last_accessed_at_ms: u64,
}

#[derive(Default)]
pub struct HttpStreamSessionRegistry {
    sessions: RwLock<HashMap<String, RegisteredHttpStream>>,
}

impl HttpStreamSessionRegistry {
    pub fn register(
        &self,
        token: String,
        torrent_id: String,
        root_key: String,
        path: String,
        file_size: u64,
        mime_type: Option<String>,
    ) -> RegisteredHttpStream {
        let now = now_ms();
        let session = RegisteredHttpStream {
            token: token.clone(),
            torrent_id,
            root_key,
            path,
            file_size,
            mime_type,
            created_at_ms: now,
            last_accessed_at_ms: now,
        };
        let mut sessions = self.sessions.write().expect("http stream registry poisoned");
        sessions.retain(|_, existing| !is_expired(existing, now));
        sessions.insert(token, session.clone());
        session
    }

    pub fn get_and_touch(&self, token: &str) -> Option<RegisteredHttpStream> {
        let now = now_ms();
        let mut sessions = self.sessions.write().expect("http stream registry poisoned");
        match sessions.get_mut(token) {
            Some(session) if !is_expired(session, now) => {
                session.last_accessed_at_ms = now;
                Some(session.clone())
            }
            Some(_) => {
                sessions.remove(token);
                None
            }
            None => None,
        }
    }

    pub fn revoke(&self, token: &str) -> bool {
        let mut sessions = self.sessions.write().expect("http stream registry poisoned");
        sessions.remove(token).is_some()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterStreamRequest {
    stream_token: String,
    torrent_id: String,
    root_key: String,
    path: String,
    file_size: u64,
    mime_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterStreamResponse {
    ok: bool,
    media_port: u16,
}

#[derive(Clone, Copy)]
struct HttpByteRange {
    start: u64,
    end_inclusive: u64,
    total_size: u64,
    partial: bool,
}

impl HttpByteRange {
    fn content_length(self) -> u64 {
        if self.total_size == 0 || self.end_inclusive < self.start {
            0
        } else {
            self.end_inclusive - self.start + 1
        }
    }

    fn content_range_header(self) -> String {
        format!("bytes {}-{}/{}", self.start, self.end_inclusive, self.total_size)
    }
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/stream/register", post(register_http_stream))
}

async fn register_http_stream(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RegisterStreamRequest>,
) -> Result<Json<RegisterStreamResponse>, (StatusCode, String)> {
    if payload.stream_token.trim().is_empty() || payload.stream_token.len() > 256 {
        return Err((StatusCode::BAD_REQUEST, "Invalid streamToken".to_string()));
    }
    if payload.torrent_id.trim().is_empty() || payload.torrent_id.len() > 256 {
        return Err((StatusCode::BAD_REQUEST, "Invalid torrentId".to_string()));
    }
    if payload.root_key.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Invalid rootKey".to_string()));
    }
    if payload.path.trim().is_empty() || payload.path.contains("..") {
        return Err((StatusCode::BAD_REQUEST, "Invalid path".to_string()));
    }

    let full_path = validate_path(&state, &payload.root_key, &payload.path)?;
    let metadata = tokio::fs::metadata(&full_path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !metadata.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Path is not a file".to_string()));
    }

    state.http_streams.register(
        payload.stream_token,
        payload.torrent_id,
        payload.root_key,
        payload.path,
        payload.file_size,
        payload.mime_type,
    );

    let media_port = ensure_media_server_started(state).await?;
    Ok(Json(RegisterStreamResponse {
        ok: true,
        media_port,
    }))
}

async fn ensure_media_server_started(
    state: Arc<AppState>,
) -> Result<u16, (StatusCode, String)> {
    let mut media_state = state.media_server.lock().await;
    if let Some(port) = media_state.port {
        return Ok(port);
    }

    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(internal_error)?;
    let port = listener.local_addr().map_err(internal_error)?.port();

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/stream/:token", get(stream_file))
        .with_state(state.clone());

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("media server error: {}", error);
        }
    });

    tracing::info!("media server started on 0.0.0.0:{}", port);
    media_state.port = Some(port);
    Ok(port)
}

async fn stream_file(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if token.trim().is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let Some(stream) = state.http_streams.get_and_touch(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let full_path = match validate_path(&state, &stream.root_key, &stream.path) {
        Ok(path) => path,
        Err((status, message)) => {
            state.http_streams.revoke(&token);
            return (status, message).into_response();
        }
    };

    let metadata = match tokio::fs::metadata(&full_path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            state.http_streams.revoke(&token);
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(_) => {
            state.http_streams.revoke(&token);
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    let total_size = metadata.len();
    let Some(range) = resolve_http_byte_range(
        headers
            .get(axum::http::header::RANGE)
            .and_then(|value| value.to_str().ok()),
        total_size,
    ) else {
        return range_not_satisfiable(total_size);
    };

    let mut response = Response::builder()
        .status(if range.partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, stream.mime_type.unwrap_or_else(|| "application/octet-stream".into()))
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "private, no-store")
        .header(PRAGMA, "no-cache")
        .header(CONTENT_LENGTH, range.content_length().to_string());

    if range.partial {
        response = response.header(CONTENT_RANGE, range.content_range_header());
    }

    if method == Method::HEAD {
        return response.body(Body::empty()).unwrap_or_else(internal_response_error);
    }

    let mut file = match File::open(&full_path).await {
        Ok(file) => file,
        Err(error) => return internal_error_response(error),
    };

    if let Err(error) = file.seek(SeekFrom::Start(range.start)).await {
        return internal_error_response(error);
    }

    let stream_body = ReaderStream::new(file.take(range.content_length()));
    response
        .body(Body::from_stream(stream_body))
        .unwrap_or_else(internal_response_error)
}

fn range_not_satisfiable(total_size: u64) -> Response {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_RANGE, format!("bytes */{total_size}"))
        .header(CONTENT_LENGTH, "0")
        .body(Body::empty())
        .unwrap_or_else(internal_response_error)
}

fn resolve_http_byte_range(range_header: Option<&str>, total_size: u64) -> Option<HttpByteRange> {
    if let Some(range_header) = range_header {
        if !range_header.starts_with("bytes=") || total_size == 0 {
            return None;
        }

        let spec = range_header.trim_start_matches("bytes=").trim();
        if spec.is_empty() || spec.contains(',') {
            return None;
        }

        let (start_part, end_part) = spec.split_once('-')?;
        let start_part = start_part.trim();
        let end_part = end_part.trim();

        if start_part.is_empty() {
            let suffix_length = end_part.parse::<u64>().ok()?;
            if suffix_length == 0 {
                return None;
            }
            let start = total_size.saturating_sub(suffix_length);
            return Some(HttpByteRange {
                start,
                end_inclusive: total_size.saturating_sub(1),
                total_size,
                partial: true,
            });
        }

        let start = start_part.parse::<u64>().ok()?;
        if start >= total_size {
            return None;
        }

        let end_inclusive = if end_part.is_empty() {
            total_size.saturating_sub(1)
        } else {
            end_part
                .parse::<u64>()
                .ok()?
                .min(total_size.saturating_sub(1))
        };
        if end_inclusive < start {
            return None;
        }

        return Some(HttpByteRange {
            start,
            end_inclusive,
            total_size,
            partial: true,
        });
    }

    Some(HttpByteRange {
        start: 0,
        end_inclusive: total_size.saturating_sub(1),
        total_size,
        partial: false,
    })
}

fn is_expired(session: &RegisteredHttpStream, now_ms: u64) -> bool {
    now_ms.saturating_sub(session.last_accessed_at_ms) > DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn internal_error<E: std::fmt::Display>(error: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn internal_error_response<E: std::fmt::Display>(error: E) -> Response {
    internal_error(error).into_response()
}

fn internal_response_error(error: axum::http::Error) -> Response {
    internal_error_response(error)
}

#[cfg(test)]
mod tests {
    use super::{resolve_http_byte_range, HttpByteRange};

    #[test]
    fn resolves_full_range_without_header() {
        assert_eq!(
            range_tuple(resolve_http_byte_range(None, 100)),
            Some((0, 99, false))
        );
    }

    #[test]
    fn resolves_explicit_partial_range() {
        assert_eq!(
            range_tuple(resolve_http_byte_range(Some("bytes=10-19"), 100)),
            Some((10, 19, true))
        );
    }

    #[test]
    fn resolves_suffix_range() {
        assert_eq!(
            range_tuple(resolve_http_byte_range(Some("bytes=-10"), 100)),
            Some((90, 99, true))
        );
    }

    #[test]
    fn rejects_invalid_or_multi_ranges() {
        assert!(resolve_http_byte_range(Some("bytes=10-5"), 100).is_none());
        assert!(resolve_http_byte_range(Some("bytes=1-2,4-5"), 100).is_none());
        assert!(resolve_http_byte_range(Some("items=0-9"), 100).is_none());
    }

    fn range_tuple(range: Option<HttpByteRange>) -> Option<(u64, u64, bool)> {
        range.map(|value| (value.start, value.end_inclusive, value.partial))
    }
}
