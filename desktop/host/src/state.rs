use crate::protocol::Event;
use std::sync::Mutex;
use tokio::sync::mpsc;

pub struct State {
    pub event_sender: Option<mpsc::Sender<Event>>,
    pub rpc_info: Mutex<Option<crate::rpc::RpcInfo>>,
}

impl State {
    pub fn new(event_sender: Option<mpsc::Sender<Event>>) -> Self {
        Self {
            event_sender,
            rpc_info: Mutex::new(None),
        }
    }
}
