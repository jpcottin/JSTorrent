use crate::kv_store::KvStore;
use crate::protocol::Event;
use std::sync::Mutex;
use tokio::sync::mpsc;

pub struct State {
    pub event_sender: Option<mpsc::Sender<Event>>,
    pub rpc_info: Mutex<Option<crate::rpc::RpcInfo>>,
    pub kv: Mutex<KvStore>,
    #[allow(dead_code)] // Read in later phases (Phase 6+)
    pub launcher: String,
    pub blocked_by_tauri: Mutex<Option<u32>>,
}

impl State {
    pub fn new(
        event_sender: Option<mpsc::Sender<Event>>,
        kv: KvStore,
        launcher: String,
        blocked_by_tauri: Option<u32>,
    ) -> Self {
        Self {
            event_sender,
            rpc_info: Mutex::new(None),
            kv: Mutex::new(kv),
            launcher,
            blocked_by_tauri: Mutex::new(blocked_by_tauri),
        }
    }
}
