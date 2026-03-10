use crate::media::{
    HttpStreamSessionRegistry, TorrentHttpStreamBridge, TorrentHttpStreamError,
    TorrentHttpStreamStatus,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

pub(crate) const OP_CTRL_REGISTER_HTTP_STREAM: u8 = 0xEC;
pub(crate) const OP_CTRL_GET_CAPABILITIES: u8 = 0xED;
pub(crate) const OP_CTRL_OPEN_HTTP_STREAM_SESSION: u8 = 0xEE;
pub(crate) const OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE: u8 = 0xEF;
#[allow(dead_code)]
pub(crate) const OP_CTRL_CANCEL_HTTP_STREAM_RANGE_WAIT: u8 = 0xF0;
pub(crate) const OP_CTRL_CLOSE_HTTP_STREAM_SESSION: u8 = 0xF1;
pub(crate) const OP_CTRL_REVOKE_TORRENT_HTTP_STREAMS: u8 = 0xF2;

const PROTOCOL_VERSION: u8 = 1;
const DEFAULT_CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

struct PendingControlRequest {
    opcode: u8,
    responder: oneshot::Sender<Result<Value, String>>,
}

pub(crate) struct ControlStreamSession {
    owner_id: String,
    tx: mpsc::Sender<Vec<u8>>,
    next_request_id: AtomicU32,
    pending: Mutex<HashMap<u32, PendingControlRequest>>,
}

impl ControlStreamSession {
    pub(crate) fn new(owner_id: String, tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self {
            owner_id,
            tx,
            next_request_id: AtomicU32::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub(crate) async fn send_request(
        &self,
        opcode: u8,
        payload: Value,
        timeout_duration: Option<Duration>,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        self.pending.lock().await.insert(
            request_id,
            PendingControlRequest {
                opcode,
                responder: response_tx,
            },
        );

        if let Err(error) = self.tx.send(build_frame(opcode, request_id, payload)).await {
            self.pending.lock().await.remove(&request_id);
            return Err(format!("Control stream send failed: {error}"));
        }

        let response = match timeout_duration {
            Some(duration) => timeout(duration, response_rx)
                .await
                .map_err(|_| "Control stream request timed out".to_string())?,
            None => response_rx.await,
        };

        match response {
            Ok(payload) => payload,
            Err(_) => Err("Control stream response dropped".to_string()),
        }
    }

    pub(crate) async fn send_notification(&self, opcode: u8, payload: Value) -> Result<(), String> {
        self.tx
            .send(build_frame(opcode, 0, payload))
            .await
            .map_err(|error| format!("Control stream send failed: {error}"))
    }

    pub(crate) async fn handle_response(
        &self,
        opcode: u8,
        request_id: u32,
        payload: Value,
    ) -> bool {
        let pending = self.pending.lock().await.remove(&request_id);
        let Some(pending) = pending else {
            return false;
        };

        if pending.opcode != opcode {
            let _ = pending
                .responder
                .send(Err("Control stream opcode mismatch".to_string()));
            return true;
        }

        let _ = pending.responder.send(Ok(payload));
        true
    }

    pub(crate) async fn handle_error(&self, request_id: u32, message: String) -> bool {
        let pending = self.pending.lock().await.remove(&request_id);
        let Some(pending) = pending else {
            return false;
        };
        let _ = pending.responder.send(Err(message));
        true
    }

    pub(crate) async fn close(&self, reason: &str) {
        let mut pending_guard = self.pending.lock().await;
        let pending = std::mem::take(&mut *pending_guard);
        drop(pending_guard);
        for (_, entry) in pending {
            let _ = entry.responder.send(Err(reason.to_string()));
        }
    }
}

#[derive(Default)]
pub struct ControlStreamSessionRegistry {
    sessions: RwLock<HashMap<String, Arc<ControlStreamSession>>>,
}

impl ControlStreamSessionRegistry {
    pub(crate) fn insert(&self, session: Arc<ControlStreamSession>) {
        self.sessions
            .write()
            .expect("control stream registry poisoned")
            .insert(session.owner_id().to_string(), session);
    }

    pub(crate) fn get(&self, owner_id: &str) -> Option<Arc<ControlStreamSession>> {
        self.sessions
            .read()
            .expect("control stream registry poisoned")
            .get(owner_id)
            .cloned()
    }

    pub(crate) fn remove(&self, owner_id: &str) -> Option<Arc<ControlStreamSession>> {
        self.sessions
            .write()
            .expect("control stream registry poisoned")
            .remove(owner_id)
    }
}

pub(crate) struct ControlChannelTorrentHttpStreamBridge {
    http_streams: Arc<HttpStreamSessionRegistry>,
    control_sessions: Arc<ControlStreamSessionRegistry>,
    active_sessions: RwLock<HashMap<String, String>>,
}

impl ControlChannelTorrentHttpStreamBridge {
    pub(crate) fn new(
        http_streams: Arc<HttpStreamSessionRegistry>,
        control_sessions: Arc<ControlStreamSessionRegistry>,
    ) -> Self {
        Self {
            http_streams,
            control_sessions,
            active_sessions: RwLock::new(HashMap::new()),
        }
    }

    fn get_active_owner(&self, session_id: &str) -> Result<String, TorrentHttpStreamError> {
        self.active_sessions
            .read()
            .expect("active stream registry poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                TorrentHttpStreamError::new(
                    TorrentHttpStreamStatus::StreamSessionNotFound,
                    "HTTP stream session not found",
                )
            })
    }

    fn get_control_session(
        &self,
        owner_id: &str,
    ) -> Result<Arc<ControlStreamSession>, TorrentHttpStreamError> {
        self.control_sessions.get(owner_id).ok_or_else(|| {
            TorrentHttpStreamError::new(
                TorrentHttpStreamStatus::StreamSessionNotFound,
                "Control stream session not found",
            )
        })
    }

    fn resolve_owner(
        &self,
        stream_token: &str,
    ) -> Result<(String, Arc<ControlStreamSession>), TorrentHttpStreamError> {
        let stream = self.http_streams.peek(stream_token).ok_or_else(|| {
            TorrentHttpStreamError::new(
                TorrentHttpStreamStatus::StreamSessionNotFound,
                "HTTP stream token not found",
            )
        })?;
        let owner_id = stream.owner_id.ok_or_else(|| {
            TorrentHttpStreamError::new(
                TorrentHttpStreamStatus::StreamSessionNotFound,
                "HTTP stream token has no control owner",
            )
        })?;
        let session = self.get_control_session(&owner_id)?;
        Ok((owner_id, session))
    }
}

#[async_trait]
impl TorrentHttpStreamBridge for ControlChannelTorrentHttpStreamBridge {
    async fn open_stream_session(
        &self,
        session_id: &str,
        stream_token: &str,
        torrent_id: &str,
        file_index: u32,
    ) -> Result<(), TorrentHttpStreamError> {
        let (owner_id, control_session) = self.resolve_owner(stream_token)?;
        let payload = control_session
            .send_request(
                OP_CTRL_OPEN_HTTP_STREAM_SESSION,
                json!({
                    "sessionId": session_id,
                    "streamToken": stream_token,
                    "torrentId": torrent_id,
                    "fileIndex": file_index,
                }),
                Some(DEFAULT_CONTROL_REQUEST_TIMEOUT),
            )
            .await
            .map_err(|message| {
                TorrentHttpStreamError::new(TorrentHttpStreamStatus::StreamSessionNotFound, message)
            })?;
        ensure_ok(payload)?;
        self.active_sessions
            .write()
            .expect("active stream registry poisoned")
            .insert(session_id.to_string(), owner_id);
        Ok(())
    }

    async fn wait_for_range(
        &self,
        session_id: &str,
        _stream_token: &str,
        torrent_id: &str,
        file_index: u32,
        offset: u64,
        length: usize,
    ) -> Result<(), TorrentHttpStreamError> {
        let owner_id = self.get_active_owner(session_id)?;
        let control_session = self.get_control_session(&owner_id)?;
        let payload = control_session
            .send_request(
                OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE,
                json!({
                    "sessionId": session_id,
                    "torrentId": torrent_id,
                    "fileIndex": file_index,
                    "offset": offset,
                    "length": length,
                }),
                None,
            )
            .await
            .map_err(|message| {
                TorrentHttpStreamError::new(TorrentHttpStreamStatus::StreamSessionNotFound, message)
            })?;
        ensure_ok(payload)
    }

    fn close_stream_session(&self, session_id: &str, reason: &str) {
        let owner_id = self
            .active_sessions
            .write()
            .expect("active stream registry poisoned")
            .remove(session_id);
        let Some(owner_id) = owner_id else {
            return;
        };
        let Some(control_session) = self.control_sessions.get(&owner_id) else {
            return;
        };
        let payload = json!({
            "sessionId": session_id,
            "reason": reason,
        });
        tokio::spawn(async move {
            let _ = control_session
                .send_notification(OP_CTRL_CLOSE_HTTP_STREAM_SESSION, payload)
                .await;
        });
    }
}

fn ensure_ok(payload: Value) -> Result<(), TorrentHttpStreamError> {
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }

    let status = match payload.get("status").and_then(Value::as_str) {
        Some("FileSkipped") => TorrentHttpStreamStatus::FileSkipped,
        Some("StreamSessionMismatch") => TorrentHttpStreamStatus::StreamSessionMismatch,
        Some("StreamSessionNotFound") => TorrentHttpStreamStatus::StreamSessionNotFound,
        Some("TorrentErrored") => TorrentHttpStreamStatus::TorrentErrored,
        Some("TorrentInactive") => TorrentHttpStreamStatus::TorrentInactive,
        Some("TorrentRemoved") => TorrentHttpStreamStatus::TorrentRemoved,
        Some("TorrentStopped") => TorrentHttpStreamStatus::TorrentStopped,
        _ => TorrentHttpStreamStatus::StreamSessionNotFound,
    };
    let message = payload
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Control stream request failed");
    Err(TorrentHttpStreamError::new(status, message))
}

fn build_frame(opcode: u8, request_id: u32, payload: Value) -> Vec<u8> {
    let mut frame = vec![0u8; 8];
    frame[0] = PROTOCOL_VERSION;
    frame[1] = opcode;
    frame[4..8].copy_from_slice(&request_id.to_le_bytes());
    let payload_bytes = serde_json::to_vec(&payload).unwrap_or_default();
    frame.extend_from_slice(&payload_bytes);
    frame
}

#[cfg(test)]
mod tests {
    use super::{
        ControlChannelTorrentHttpStreamBridge, ControlStreamSession, ControlStreamSessionRegistry,
        OP_CTRL_CLOSE_HTTP_STREAM_SESSION, OP_CTRL_OPEN_HTTP_STREAM_SESSION,
        OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE,
    };
    use crate::media::{HttpStreamSessionRegistry, TorrentHttpStreamBridge};
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn control_bridge_routes_open_wait_and_close_to_owner_session() {
        let http_streams = Arc::new(HttpStreamSessionRegistry::default());
        http_streams.register(
            "token-a".to_string(),
            Some("owner-a".to_string()),
            "torrent-a".to_string(),
            3,
            "root-a".to_string(),
            "video.mp4".to_string(),
            1024,
            Some("video/mp4".to_string()),
        );

        let (tx, mut rx) = mpsc::channel(8);
        let session = Arc::new(ControlStreamSession::new("owner-a".to_string(), tx));
        let registry = Arc::new(ControlStreamSessionRegistry::default());
        registry.insert(session.clone());

        let bridge = Arc::new(ControlChannelTorrentHttpStreamBridge::new(
            http_streams,
            registry,
        ));

        let open_task = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .open_stream_session("session-a", "token-a", "torrent-a", 3)
                    .await
            })
        };
        let open_frame = rx.recv().await.expect("open frame");
        let (opcode, request_id, payload) = parse_frame(&open_frame);
        assert_eq!(opcode, OP_CTRL_OPEN_HTTP_STREAM_SESSION);
        assert_eq!(payload["streamToken"], Value::from("token-a"));
        assert_eq!(payload["fileIndex"], Value::from(3));
        assert!(
            session
                .handle_response(opcode, request_id, serde_json::json!({ "ok": true }))
                .await
        );
        open_task.await.expect("open task").expect("open session");

        let wait_task = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .wait_for_range("session-a", "token-a", "torrent-a", 3, 4096, 8192)
                    .await
            })
        };
        let wait_frame = rx.recv().await.expect("wait frame");
        let (opcode, request_id, payload) = parse_frame(&wait_frame);
        assert_eq!(opcode, OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE);
        assert_eq!(payload["offset"], Value::from(4096));
        assert_eq!(payload["length"], Value::from(8192));
        assert!(
            session
                .handle_response(opcode, request_id, serde_json::json!({ "ok": true }))
                .await
        );
        wait_task.await.expect("wait task").expect("wait range");

        bridge.close_stream_session("session-a", "request-complete");
        let close_frame = rx.recv().await.expect("close frame");
        let (opcode, request_id, payload) = parse_frame(&close_frame);
        assert_eq!(opcode, OP_CTRL_CLOSE_HTTP_STREAM_SESSION);
        assert_eq!(request_id, 0);
        assert_eq!(payload["sessionId"], Value::from("session-a"));
        assert_eq!(payload["reason"], Value::from("request-complete"));
    }

    fn parse_frame(frame: &[u8]) -> (u8, u32, Value) {
        assert!(frame.len() >= 8);
        let opcode = frame[1];
        let request_id = u32::from_le_bytes(frame[4..8].try_into().expect("request id"));
        let payload = serde_json::from_slice(&frame[8..]).expect("json payload");
        (opcode, request_id, payload)
    }
}
