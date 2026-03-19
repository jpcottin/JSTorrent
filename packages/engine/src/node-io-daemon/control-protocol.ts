export const CONTROL_OP_ROOTS_CHANGED = 0xe0
export const CONTROL_OP_EVENT = 0xe1
export const CONTROL_OP_OPEN_FOLDER_PICKER = 0xe2
export const CONTROL_OP_OPEN_FILE = 0xe9
export const CONTROL_OP_REVEAL_IN_FOLDER = 0xea
export const CONTROL_OP_POWER_HINT = 0xeb
export const CONTROL_OP_REGISTER_HTTP_STREAM = 0xec
export const CONTROL_OP_GET_CAPABILITIES = 0xed
export const CONTROL_OP_OPEN_HTTP_STREAM_SESSION = 0xee
export const CONTROL_OP_WAIT_FOR_HTTP_STREAM_RANGE = 0xef
export const CONTROL_OP_CANCEL_HTTP_STREAM_RANGE_WAIT = 0xf0
export const CONTROL_OP_CLOSE_HTTP_STREAM_SESSION = 0xf1
export const CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS = 0xf2

export interface NodeIoDaemonExternalCapabilities {
  protocolVersion: number
  behaviorVersion: number
  roots_manageable: boolean
  lan_share_urls: boolean
  free_space: boolean
  write_atomic: boolean
}
