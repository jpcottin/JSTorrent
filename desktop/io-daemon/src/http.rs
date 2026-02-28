use axum::{routing::get, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Serialize)]
struct NetworkInterface {
    name: String,
    address: String,
    #[serde(rename = "prefixLength")]
    prefix_length: u8,
}

#[derive(Serialize)]
struct GatewayInfo {
    ip: String,
    #[serde(rename = "interfaceName", skip_serializing_if = "Option::is_none")]
    interface_name: Option<String>,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/network/interfaces", get(network_interfaces))
        .route("/network/gateway", get(default_gateway))
}

async fn network_interfaces() -> Json<Vec<NetworkInterface>> {
    let interfaces = if_addrs::get_if_addrs()
        .map(|addrs| {
            addrs
                .into_iter()
                .filter_map(|iface| {
                    if let std::net::IpAddr::V4(addr) = iface.ip() {
                        let prefix_length = match iface.addr {
                            if_addrs::IfAddr::V4(ref v4) => {
                                let mask = u32::from(v4.netmask);
                                mask.count_ones() as u8
                            }
                            if_addrs::IfAddr::V6(_) => 24,
                        };
                        Some(NetworkInterface {
                            name: iface.name,
                            address: addr.to_string(),
                            prefix_length,
                        })
                    } else {
                        None // Skip IPv6
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Json(interfaces)
}

async fn default_gateway() -> Json<Option<GatewayInfo>> {
    let info = netdev::get_default_gateway().ok().and_then(|gw| {
        gw.ipv4.first().map(|ipv4| GatewayInfo {
            ip: ipv4.to_string(),
            interface_name: None,
        })
    });
    Json(info)
}
