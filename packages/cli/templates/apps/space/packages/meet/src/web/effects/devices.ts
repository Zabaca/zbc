// Which microphones and cameras there are, kept current as they are plugged in and out.

export const listDevices = (): Promise<MediaDeviceInfo[]> => navigator.mediaDevices.enumerateDevices().catch(() => [])

/** Calls `fn` when a device appears or goes. Returns the way to stop. */
export function onDevicesChange(fn: () => void): () => void {
  const md = navigator.mediaDevices
  md?.addEventListener?.('devicechange', fn)
  return () => md?.removeEventListener?.('devicechange', fn)
}
