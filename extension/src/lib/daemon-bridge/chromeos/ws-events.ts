import type { DownloadRoot } from '../../native-connection'
import { decodeControlFrameJsonPayload } from '../protocol/control-frame'
import { mapCompanionRoots, type CompanionRoot } from '../protocol/root-mapper'

export interface ChromeosNativeEvent {
  event: string
  payload: unknown
}

export function parseRootsChangedFrame(frame: Uint8Array): DownloadRoot[] {
  const roots = decodeControlFrameJsonPayload<CompanionRoot[]>(frame)
  return mapCompanionRoots(roots)
}

export function parseControlEventFrame(frame: Uint8Array): ChromeosNativeEvent {
  return decodeControlFrameJsonPayload<ChromeosNativeEvent>(frame)
}
