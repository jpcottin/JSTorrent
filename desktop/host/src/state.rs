use crate::kv_store::KvStore;
use crate::protocol::Event;
use std::sync::Mutex;
use tokio::sync::mpsc;

pub struct State {
    pub event_sender: Option<mpsc::Sender<Event>>,
    pub rpc_info: Mutex<Option<crate::rpc::RpcWriteInfo>>,
    pub kv: Mutex<Option<KvStore>>,
    #[allow(dead_code)]
    pub launcher: String,
    pub profile_id: Mutex<Option<String>>,
}

impl State {
    pub fn new(event_sender: Option<mpsc::Sender<Event>>, launcher: String) -> Self {
        Self {
            event_sender,
            rpc_info: Mutex::new(None),
            kv: Mutex::new(None),
            launcher,
            profile_id: Mutex::new(None),
        }
    }
}
