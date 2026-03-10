export const CONTROL_OP_ROOTS_CHANGED = 0xe0
export const CONTROL_OP_EVENT = 0xe1
export const CONTROL_OP_OPEN_FOLDER_PICKER = 0xe2
export const CONTROL_OP_OPEN_FILE = 0xe9
export const CONTROL_OP_REVEAL_IN_FOLDER = 0xea
export const CONTROL_OP_POWER_HINT = 0xeb
export const CONTROL_OP_REGISTER_HTTP_STREAM = 0xec
export const CONTROL_OP_GET_CAPABILITIES = 0xed

export interface NodeIoDaemonExternalCapabilities {
  roots_manageable: boolean
  lan_share_urls: boolean
}
