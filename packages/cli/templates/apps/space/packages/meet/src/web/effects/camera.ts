// The camera as the call publishes it. One published sender, many sources:
//
//   - the raw camera track,
//   - the blurred track (blur on), swapped in with replaceTrack,
//   - a black placeholder at one frame a second (camera off), with the real
//     camera stopped so its light goes out.
//
// The controller listens for `outgoing` changes and calls replaceTrack. Because
// the placeholder keeps sending packets, the SFU does not drop the publication
// after 30 seconds without any; others see the person's name instead, from the
// camera-off flag.

import type { BlurPipeline } from './blur'

export const cameraConstraints = (deviceId?: string): MediaTrackConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
})

/** A black picture that still changes a little each half second, so a capture keeps emitting frames. */
function placeholderTrack(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  let tick = 0
  const paint = () => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = tick++ % 2 ? '#010101' : '#000'
    ctx.fillRect(0, 0, 4, 4)
  }
  paint()
  const stream = canvas.captureStream(1)
  const timer = setInterval(paint, 500)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack
  return {
    track,
    stop: () => {
      clearInterval(timer)
      track.stop()
    },
  }
}

export class CameraSource {
  private raw: MediaStreamTrack | null
  private blurPipeline: BlurPipeline | null = null
  private placeholder: ReturnType<typeof placeholderTrack> | null = null
  private current: MediaStreamTrack
  private blurOn: boolean
  private off = false
  private listeners = new Set<(t: MediaStreamTrack) => void>()
  private chain: Promise<void> = Promise.resolve()
  private stopped = false

  /** Failure to start blur is reported here (and blur falls back to off). */
  onBlurError: (message: string) => void = () => {}

  constructor(
    raw: MediaStreamTrack | null,
    private readonly deviceId: string | undefined,
    blur: boolean,
    private readonly blurPath: 'auto' | 'canvas' = 'auto',
  ) {
    this.raw = raw
    this.available = raw !== null
    this.blurOn = blur
    // A guest who allowed only the microphone has no camera: start with the placeholder.
    if (raw) this.current = raw
    else {
      this.off = true
      this.placeholder = placeholderTrack()
      this.current = this.placeholder.track
    }
  }

  /** The track to publish and to preview. */
  get outgoing(): MediaStreamTrack {
    return this.current
  }
  get blur(): boolean {
    return this.blurOn
  }
  get cameraOff(): boolean {
    return this.off
  }
  /** False when the person never gave a camera: the call then shows their name and the camera button is off. */
  readonly available: boolean

  subscribe(fn: (t: MediaStreamTrack) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setBlur(on: boolean): Promise<void> {
    this.blurOn = on
    return this.apply()
  }

  setCameraOff(off: boolean): Promise<void> {
    this.off = off
    return this.apply()
  }

  /** Changes are applied one at a time, in order, so a quick double tap cannot race itself. */
  private apply(): Promise<void> {
    this.chain = this.chain.then(() => this.reconcile()).catch((err) => console.warn('camera', err))
    return this.chain
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return
    let next: MediaStreamTrack
    if (this.off) {
      this.releaseBlur()
      if (this.raw) {
        this.raw.stop()
        this.raw = null
      }
      this.placeholder ??= placeholderTrack()
      next = this.placeholder.track
    } else {
      if (!this.raw || this.raw.readyState === 'ended') {
        const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(this.deviceId) })
        this.raw = stream.getVideoTracks()[0] as MediaStreamTrack
      }
      if (this.blurOn) {
        if (!this.blurPipeline) {
          try {
            const { BlurPipeline } = await import('./blur')
            this.blurPipeline = await BlurPipeline.create(this.raw, { path: this.blurPath })
          } catch (err) {
            console.warn('blur could not start', err)
            this.blurOn = false
            this.onBlurError('Blur could not start on this device.')
          }
        }
        next = this.blurPipeline ? this.blurPipeline.track : this.raw
      } else {
        this.releaseBlur()
        next = this.raw
      }
      if (this.placeholder) {
        // Keep the placeholder alive until after the swap, so the sender never holds an ended track.
        const p = this.placeholder
        this.placeholder = null
        queueMicrotask(() => setTimeout(() => p.stop(), 500))
      }
    }
    if (next !== this.current) {
      this.current = next
      for (const fn of this.listeners) fn(next)
    }
  }

  private releaseBlur(): void {
    this.blurPipeline?.stop()
    this.blurPipeline = null
  }

  stop(): void {
    this.stopped = true
    this.releaseBlur()
    this.raw?.stop()
    this.placeholder?.stop()
    this.listeners.clear()
  }
}
