export interface NetworkInterface {
  name: string
  address: string
  prefixLength: number
}

export interface GatewayInfo {
  ip: string
  interfaceName?: string
}
