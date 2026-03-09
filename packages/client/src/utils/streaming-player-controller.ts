import type {
  DirectBytePlaybackOption,
  StreamingPlaybackHandle,
  StreamingPlaybackMode,
  StreamingPlaybackOption,
  StreamingPlayerController,
  StreamingVisualization,
  ByteRangeStreamingSession,
} from '@jstorrent/engine'

interface CreateStreamingPlayerControllerOptions {
  base?: StreamingPlayerController
  getDirectByteOption?: () => Promise<DirectBytePlaybackOption | null>
}

interface CreateStreamingPlaybackHandleOptions {
  bytes: ByteRangeStreamingSession
  controller?: StreamingPlayerController
  diagnostics?: StreamingVisualization
  getDirectByteOption?: () => Promise<DirectBytePlaybackOption | null>
}

function mergePlaybackOptions(
  baseOptions: StreamingPlaybackOption[] | null,
  directByteOption: DirectBytePlaybackOption | null,
): StreamingPlaybackOption[] | null {
  const options: StreamingPlaybackOption[] = []
  if (directByteOption) {
    options.push(directByteOption)
  }
  for (const option of baseOptions ?? []) {
    if (option.mode === 'direct-bytes') continue
    options.push(option)
  }
  return options.length > 0 ? options : null
}

export function createStreamingPlayerController(
  options: CreateStreamingPlayerControllerOptions,
): StreamingPlayerController | undefined {
  const { base, getDirectByteOption } = options
  if (!base && !getDirectByteOption) {
    return undefined
  }

  let directByteOptionPromise: Promise<DirectBytePlaybackOption | null> | null = null
  const loadDirectByteOption = () => {
    if (!getDirectByteOption) {
      return Promise.resolve(null)
    }
    if (!directByteOptionPromise) {
      directByteOptionPromise = getDirectByteOption().catch((error) => {
        directByteOptionPromise = null
        throw error
      })
    }
    return directByteOptionPromise
  }

  return {
    getPlaybackCapabilities: base?.getPlaybackCapabilities
      ? () => base.getPlaybackCapabilities?.() ?? Promise.resolve(null)
      : undefined,
    getPlaybackOptions: async () => {
      const [baseOptions, directByteOption] = await Promise.all([
        base?.getPlaybackOptions?.() ?? Promise.resolve(null),
        loadDirectByteOption(),
      ])
      return mergePlaybackOptions(baseOptions, directByteOption)
    },
    preparePlaybackMetadata: base?.preparePlaybackMetadata
      ? () => base.preparePlaybackMetadata?.() ?? Promise.resolve(null)
      : undefined,
    getPreparedPlaybackMetadata: base?.getPreparedPlaybackMetadata
      ? () => base.getPreparedPlaybackMetadata?.() ?? Promise.resolve(null)
      : undefined,
  }
}

export function createStreamingPlaybackHandle(
  options: CreateStreamingPlaybackHandleOptions,
): StreamingPlaybackHandle {
  return {
    bytes: options.bytes,
    controller: createStreamingPlayerController({
      base: options.controller,
      getDirectByteOption: options.getDirectByteOption,
    }),
    diagnostics: options.diagnostics,
  }
}

export function isDirectBytePlaybackMode(mode: StreamingPlaybackMode): boolean {
  return mode === 'direct-bytes'
}
