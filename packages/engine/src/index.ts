// Core
export { BtEngine } from './core/bt-engine'
export type { DaemonOpType, UPnPStatus } from './core/bt-engine'
export { Torrent } from './core/torrent'
export type { DisplayPeer } from './core/torrent'
export { BandwidthTracker, ALL_TRAFFIC_CATEGORIES } from './core/bandwidth-tracker'
export type { BandwidthTrackerConfig, TrafficCategory } from './core/bandwidth-tracker'
export { TorrentFileInfo } from './core/torrent-file-info'
export { PeerConnection } from './core/peer-connection'
export { ActivePiece } from './core/active-piece'
export { SessionPersistence } from './core/session-persistence'
export type { SwarmPeer, ConnectionState, DiscoverySource, AddressFamily } from './core/swarm'
export { addressKey } from './core/swarm'
export * from './core/peer-coordinator'
export type { TorrentListEntry, TorrentStateData } from './core/session-persistence'
export { ConnectionTimingTracker } from './core/connection-timing'
export type { ConnectionTimingStats } from './core/connection-timing'
export { EndgameManager } from './core/endgame-manager'
export type { EndgameDecision, CancelDecision, EndgameConfig } from './core/endgame-manager'

// Torrent state
export type { TorrentUserState, TorrentActivityState } from './core/torrent-state'
export { computeActivityState } from './core/torrent-state'

// Interfaces
export type {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunksRequest,
} from './interfaces/filesystem'
export { VerifyChunkResult } from './interfaces/filesystem'
export type { ISocketFactory, ITcpSocket, IUdpSocket } from './interfaces/socket'
export type { ISessionStore } from './interfaces/session-store'
export type { IHasher } from './interfaces/hasher'
export type { TrackerStats, TrackerStatus } from './interfaces/tracker'

// Logging
export type { Logger, LogEntry, LogLevel, EngineLoggingConfig } from './logging/logger'
export { LogStore, globalLogStore, defaultLogger } from './logging/logger'

// Adapters
export { MemorySessionStore } from './adapters/memory/memory-session-store'
export { LocalStorageSessionStore } from './adapters/browser/local-storage-session-store'
export { ExternalChromeStorageSessionStore } from './adapters/browser/external-chrome-storage-session-store'
export {
  IndexedDbSessionStore,
  clearIndexedDbSessionStore,
  INDEXEDDB_NAME,
} from './adapters/browser/indexeddb-session-store'
export { SubtleCryptoHasher } from './adapters/browser/subtle-crypto-hasher'
export { RoutingHasher } from './adapters/browser/routing-hasher'
export { WorkerHasher } from './adapters/browser/worker-hasher'
export {
  TransferringWorkerHasher,
  type TransferringHashResult,
} from './adapters/browser/transferring-worker-hasher'
export { DaemonConnection } from './adapters/daemon/daemon-connection'
export type {
  IDaemonConnection,
  DaemonCredentials,
  CredentialsGetter,
} from './adapters/daemon/daemon-connection'
export { DaemonSocketFactory } from './adapters/daemon/daemon-socket-factory'
export { DaemonFileSystem } from './adapters/daemon/daemon-filesystem'
export { DaemonHasher } from './adapters/daemon/daemon-hasher'
export {
  getWriteStats,
  resetWriteStatsMax,
  getBatchWriteHistogram,
  getCompanionWriteQueueStats,
} from './adapters/daemon/daemon-file-handle'

// Proxy
export { Socks5SocketFactory } from './proxy'
export { Socks5Socket, type Socks5ProxyConfig } from './proxy'

// Storage
export { StorageRootManager, MissingStorageRootError } from './storage/storage-root-manager'
export type { StorageRoot } from './storage/storage-root-manager'

// Presets
export { createDaemonEngine } from './presets/daemon'
export { createNodeIoDaemon } from './node-io-daemon'
export type {
  NodeIoDaemon,
  NodeIoDaemonBootstrapMode,
  NodeIoDaemonCapabilities,
  NodeIoDaemonConfig,
  NodeIoDaemonStatus,
} from './node-io-daemon'

// Utils
export { generateMagnet, parseMagnet, createTorrentBuffer } from './utils/magnet'
export type { GenerateMagnetOptions, ParsedMagnet } from './utils/magnet'
export { RrdHistory, DEFAULT_RRD_TIERS } from './utils/rrd-history'
export type { RrdTierConfig, RrdSample, RrdSamplesResult } from './utils/rrd-history'
export { toHex, fromHex, toBase64, fromBase64 } from './utils/buffer'
export { TokenBucket } from './utils/token-bucket'
export type { InfoHashHex } from './utils/infohash'
export { infoHashFromHex, infoHashFromBytes } from './utils/infohash'
export { SleepWakeDetector } from './utils/sleep-wake-detector'
export type { SleepWakeDetectorOptions, WakeEvent } from './utils/sleep-wake-detector'

// Torrent factory and initialization
export { parseTorrentInput } from './core/torrent-factory'
export type { ParsedTorrentInput } from './core/torrent-factory'
export { initializeTorrentMetadata, initializeTorrentStorage } from './core/torrent-initializer'

// Disk Queue
export {
  TorrentDiskQueue,
  PassthroughDiskQueue,
  type IDiskQueue,
  type DiskJob,
  type DiskJobType,
  type DiskJobStatus,
  type DiskQueueSnapshot,
  type DiskQueueConfig,
} from './core/disk-queue'

// Port Mapping (UPnP / NAT-PMP / PCP)
export {
  PortMappingManager,
  PortMappingManager as UPnPManager,
  SSDPClient,
  GatewayDevice,
} from './port-mapping'
export type { PortMapping, PortMapping as UPnPMapping, SSDPDevice } from './port-mapping'
export type { NetworkInterface, GatewayInfo } from './interfaces/network'

// LPD (Local Peer Discovery)
export { LPDService } from './lpd'

// DHT
export type { DHTStats, DHTNodeInfo } from './dht'

// Config
export type {
  ConfigHub,
  ConfigValue,
  ConfigValueCallback,
  AnyConfigChangeCallback,
  ConfigKey,
  ConfigType,
  SettingConfigKey,
  RuntimeConfigKey,
  ConfigCategory,
  ConfigStorageClass,
} from './config'
export {
  MemoryConfigHub,
  BaseConfigHub,
  configSchema,
  getConfigCategory,
  getConfigStorageClass,
  getConfigDefault,
  getConfigDefaults,
  isConfigExtensionOnly,
  validateConfigValue,
} from './config'

// Streaming
export {
  createTorrentSource,
  createTorrentSourceFromProvider,
  createTorrentSourceFromSession,
} from './streaming/torrent-source'
export {
  createStreamingFileProvider,
  createStreamingPlaybackSession,
  StreamingPlaybackSession,
} from './streaming/streaming-playback-session'
export type {
  ByteRangeStreamingSession,
  DirectBytePlaybackOption,
  HlsPlaybackOption,
  PreparedPlaybackMetadata,
  StreamingActivePieceInfo,
  StreamingContainerFormat,
  StreamingPlaybackCapabilities,
  StreamingFilePieceSnapshot,
  StreamingFileProvider,
  StreamingPlaybackHandle,
  StreamingPlaybackOption,
  StreamingPlayerController,
  StreamingPlaybackMode,
  StreamingHintUrgency,
  StreamingVisualization,
} from './streaming/streaming-file-provider'
export {
  StreamingContainerFormat as StreamingContainerFormats,
  StreamingPlaybackMode as StreamingPlaybackModes,
} from './streaming/streaming-file-provider'

// Version
export { VERSION, versionToAzureusCode, azureusCodeToVersion } from './version'
