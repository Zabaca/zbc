// Screen sharing with getDisplayMedia. The person picks the entire screen, a
// window or a tab in the browser's own picker, and the share carries sound
// where the browser supports it.
//
// Picker options passed (a browser that does not know one ignores it):
//   selfBrowserSurface "exclude"   leave out the call's own tab, so nobody shares a mirror of it
//   surfaceSwitching   "include"   let the person switch what is shared mid-share
//   monitorTypeSurfaces "include"  offer whole screens
//   systemAudio        "include"   offer system sound
// No displaySurface preference, so the picker offers tab, window and screen in its usual order.

export const canShareScreen = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'

export interface Share {
  video: MediaStreamTrack
  /** Present when the browser gave the share's sound (a tab, or the system on Windows and ChromeOS). */
  audio: MediaStreamTrack | null
  stop(): void
}

export async function captureScreen(onEnded: () => void): Promise<Share> {
  const options = {
    video: { frameRate: { ideal: 15, max: 15 } },
    audio: true,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    systemAudio: 'include',
  } as DisplayMediaStreamOptions
  const stream = await navigator.mediaDevices.getDisplayMedia(options)
  const video = stream.getVideoTracks()[0] as MediaStreamTrack
  const audio = stream.getAudioTracks()[0] ?? null
  // Text must stay sharp more than motion must stay smooth.
  video.contentHint = 'detail'
  // The browser's own "Stop sharing" bar ends the track.
  video.addEventListener('ended', onEnded, { once: true })
  return {
    video,
    audio,
    stop() {
      video.removeEventListener('ended', onEnded)
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}
