use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
use crate::AppState;

/// Auth middleware for managed mode (native host launched)
pub async fn middleware(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // Allow health check and WebSocket upgrade without auth header
    // WebSocket auth is handled within the protocol
    if req.uri().path() == "/health" || req.uri().path() == "/io" {
        return Ok(next.run(req).await);
    }

    // Allow CORS preflight requests without auth
    if req.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(req).await);
    }

    let token = req.headers()
        .get("X-JST-Auth")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            req.headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        });

    let expected_token = state.token.read().unwrap().clone();
    match token {
        Some(t) if t == expected_token => {
            Ok(next.run(req).await)
        }
        _ => {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

/// Auth middleware for standalone mode (Crostini/Linux)
/// Allows pairing endpoints without auth, validates token dynamically
pub async fn standalone_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let path = req.uri().path();

    // Allow these endpoints without auth (needed for pairing flow and WebSocket)
    // WebSocket endpoints (/control, /io) authenticate via the protocol after connection
    if path == "/health"
        || path == "/io"
        || path == "/control"
        || path == "/status"
        || path == "/pair"
        || path == "/network/interfaces"
    {
        return Ok(next.run(req).await);
    }

    // Allow CORS preflight requests without auth
    if req.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(req).await);
    }

    // For all other endpoints, validate the token
    let token = req.headers()
        .get("X-JST-Auth")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            req.headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        });

    let expected_token = state.token.read().unwrap().clone();
    match token {
        Some(t) if t == expected_token => {
            Ok(next.run(req).await)
        }
        _ => {
            tracing::debug!("Standalone auth failed for path: {}", path);
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
