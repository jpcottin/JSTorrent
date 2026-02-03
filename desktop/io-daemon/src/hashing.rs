use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use crate::files::MAX_BODY_SIZE;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use crate::AppState;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        // File-based hash endpoints (return hex)
        .route("/hash/sha1/*path", get(hash_sha1_file))
        .route("/hash/sha256/*path", get(hash_sha256_file))
        // Bytes-based hash endpoints (return raw bytes)
        .route("/hash/sha1", post(hash_sha1_bytes))
        .route("/hash/sha256", post(hash_sha256_bytes))
        // Batch hash endpoint (return concatenated raw bytes)
        .route("/hash/sha1/batch", post(hash_sha1_batch))
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
}

#[derive(Deserialize)]
struct HashParams {
    offset: Option<u64>,
    length: Option<u64>,
    root_token: String,
}


/// Hash arbitrary bytes with SHA1.
/// POST /hash/sha1
/// Body: raw bytes
/// Response: raw 20-byte hash (application/octet-stream)
async fn hash_sha1_bytes(body: Bytes) -> impl IntoResponse {
    let mut hasher = Sha1::new();
    hasher.update(&body);
    let hash = hasher.finalize();
    ([(header::CONTENT_TYPE, "application/octet-stream")], hash.to_vec())
}

/// Batch hash multiple byte arrays with SHA1.
/// POST /hash/sha1/batch
/// Body: length-prefixed binary format:
///   - count (u32 little-endian): number of items
///   - For each item:
///     - len (u32 little-endian): length of data
///     - data (len bytes)
/// Response: concatenated 20-byte hashes (application/octet-stream)
async fn hash_sha1_batch(body: Bytes) -> Result<impl IntoResponse, (StatusCode, String)> {
    let results = hash_sha1_batch_inner(&body)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], results))
}

/// Core batch hashing logic, separated for testability
fn hash_sha1_batch_inner(body: &[u8]) -> Result<Vec<u8>, (StatusCode, String)> {
    const MAX_BATCH_COUNT: u32 = 10_000;

    if body.len() < 4 {
        return Err((StatusCode::BAD_REQUEST, "Body too short".to_string()));
    }

    let count = u32::from_le_bytes(body[0..4].try_into().unwrap());

    if count > MAX_BATCH_COUNT {
        return Err((StatusCode::BAD_REQUEST, format!("Too many items: {} (max {})", count, MAX_BATCH_COUNT)));
    }

    let mut offset = 4usize;
    let mut results = Vec::with_capacity(count as usize * 20);

    for i in 0..count {
        if offset + 4 > body.len() {
            return Err((StatusCode::BAD_REQUEST, format!("Truncated input at item {} length field", i)));
        }

        let len = u32::from_le_bytes(body[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;

        if offset + len > body.len() {
            return Err((StatusCode::BAD_REQUEST, format!("Truncated input at item {} data (need {} bytes, have {})", i, len, body.len() - offset)));
        }

        let data = &body[offset..offset + len];
        offset += len;

        let mut hasher = Sha1::new();
        hasher.update(data);
        results.extend_from_slice(&hasher.finalize());
    }

    Ok(results)
}

/// Hash arbitrary bytes with SHA256.
/// POST /hash/sha256
/// Body: raw bytes
/// Response: raw 32-byte hash (application/octet-stream)
async fn hash_sha256_bytes(body: Bytes) -> impl IntoResponse {
    let mut hasher = Sha256::new();
    hasher.update(&body);
    let hash = hasher.finalize();
    ([(header::CONTENT_TYPE, "application/octet-stream")], hash.to_vec())
}

/// Hash a file with SHA1. Returns hex string.
async fn hash_sha1_file(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    axum::extract::Query(params): axum::extract::Query<HashParams>,
) -> Result<String, (StatusCode, String)> {
    let full_path = crate::files::validate_path(&state, &params.root_token, &path)?;

    
    let mut file = File::open(&full_path).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    if let Some(offset) = params.offset {
        file.seek(SeekFrom::Start(offset)).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 8192];
    let mut remaining = params.length.unwrap_or(u64::MAX);

    while remaining > 0 {
        let to_read = std::cmp::min(buffer.len() as u64, remaining);
        let n = file.read(&mut buffer[..to_read as usize]).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        
        if n == 0 {
            break;
        }

        hasher.update(&buffer[..n]);
        remaining -= n as u64;
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Hash a file with SHA256. Returns hex string.
async fn hash_sha256_file(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    axum::extract::Query(params): axum::extract::Query<HashParams>,
) -> Result<String, (StatusCode, String)> {
    let full_path = crate::files::validate_path(&state, &params.root_token, &path)?;


    let mut file = File::open(&full_path).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    if let Some(offset) = params.offset {
        file.seek(SeekFrom::Start(offset)).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut remaining = params.length.unwrap_or(u64::MAX);

    while remaining > 0 {
        let to_read = std::cmp::min(buffer.len() as u64, remaining);
        let n = file.read(&mut buffer[..to_read as usize]).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        if n == 0 {
            break;
        }

        hasher.update(&buffer[..n]);
        remaining -= n as u64;
    }

    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build batch request body
    fn build_batch_request(items: &[&[u8]]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(items.len() as u32).to_le_bytes());
        for item in items {
            buf.extend_from_slice(&(item.len() as u32).to_le_bytes());
            buf.extend_from_slice(item);
        }
        buf
    }

    /// Helper to compute SHA1 hash for test verification
    fn compute_sha1(data: &[u8]) -> [u8; 20] {
        let mut hasher = Sha1::new();
        hasher.update(data);
        hasher.finalize().into()
    }

    #[test]
    fn test_batch_sha1_single_item() {
        let body = build_batch_request(&[b"hello"]);
        let response_bytes = hash_sha1_batch_inner(&body).unwrap();

        let expected = compute_sha1(b"hello");
        assert_eq!(response_bytes.len(), 20);
        assert_eq!(&response_bytes[..], &expected[..]);
    }

    #[test]
    fn test_batch_sha1_multiple_items() {
        let body = build_batch_request(&[b"hello", b"world", b""]);
        let response_bytes = hash_sha1_batch_inner(&body).unwrap();

        assert_eq!(response_bytes.len(), 60); // 3 * 20 bytes

        let hello_hash = compute_sha1(b"hello");
        let world_hash = compute_sha1(b"world");
        let empty_hash = compute_sha1(b"");

        assert_eq!(&response_bytes[0..20], &hello_hash[..]);
        assert_eq!(&response_bytes[20..40], &world_hash[..]);
        assert_eq!(&response_bytes[40..60], &empty_hash[..]);
    }

    #[test]
    fn test_batch_sha1_empty_batch() {
        let body = build_batch_request(&[]);
        let response_bytes = hash_sha1_batch_inner(&body).unwrap();

        assert_eq!(response_bytes.len(), 0);
    }

    #[test]
    fn test_batch_sha1_body_too_short() {
        let body = vec![0u8, 1, 2]; // Only 3 bytes, need at least 4
        let result = hash_sha1_batch_inner(&body);

        assert!(result.is_err());
        let (status, msg) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("too short"));
    }

    #[test]
    fn test_batch_sha1_too_many_items() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&10_001u32.to_le_bytes()); // Exceeds limit
        let result = hash_sha1_batch_inner(&buf);

        assert!(result.is_err());
        let (status, msg) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("Too many items"));
    }

    #[test]
    fn test_batch_sha1_truncated_length() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&2u32.to_le_bytes()); // 2 items
        buf.extend_from_slice(&5u32.to_le_bytes()); // len=5
        buf.extend_from_slice(b"hello"); // first item ok
        // Missing second item's length field
        let result = hash_sha1_batch_inner(&buf);

        assert!(result.is_err());
        let (status, msg) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("Truncated"));
    }

    #[test]
    fn test_batch_sha1_truncated_data() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes()); // 1 item
        buf.extend_from_slice(&100u32.to_le_bytes()); // len=100 but only provide 5 bytes
        buf.extend_from_slice(b"hello");
        let result = hash_sha1_batch_inner(&buf);

        assert!(result.is_err());
        let (status, msg) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("Truncated"));
    }

    #[test]
    fn test_batch_sha1_known_test_vectors() {
        // SHA1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
        // SHA1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
        let body = build_batch_request(&[b"hello", b""]);
        let response_bytes = hash_sha1_batch_inner(&body).unwrap();

        assert_eq!(hex::encode(&response_bytes[0..20]), "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
        assert_eq!(hex::encode(&response_bytes[20..40]), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }
}
