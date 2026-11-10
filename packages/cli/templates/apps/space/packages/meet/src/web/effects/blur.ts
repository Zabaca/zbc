// Background blur, in the sender's browser, before the picture leaves it.
//
// MediaPipe's ImageSegmenter (the selfie model, in video mode, on the GPU where
// it can) says which pixels are the person. A WebGL pass blurs the whole frame
// at a quarter of its size and mixes the sharp frame back in where the mask says
// person, with a soft edge. The last mask is reused whenever a frame arrives
// before the next one is ready, so the picture never stalls.
//
// Frames come in and go out through MediaStreamTrackProcessor and Generator
// where the page itself has both (Chrome, Edge, Android Chrome, Samsung
// Internet). Elsewhere (Safari, Firefox) a video element feeds the same WebGL
// pass and the canvas is captured. Safari's worker-only processor path is not
// used. `path: 'canvas'` forces the second path, as a test switch.
//
// The engine (14.5 MB of WebAssembly) and the model are this app's own assets,
// not Google's servers, and are fetched the first time blur is turned on: this
// module is imported dynamically by camera.ts for that reason.

import type { ImageSegmenter } from '@mediapipe/tasks-vision'
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'

// Under the bundle's own base (vite's `base`): `/r/_/` where the space serves it (the space's ADR 0018), the root in the local Worker (dev/). Outside a vite build (`bun test`) there is none: the root.
const MODEL_URL = `${(import.meta.env?.BASE_URL as string | undefined) ?? '/'}models/selfie_segmenter.tflite`
/** The largest picture sent on: a bigger camera is scaled down before the WebGL pass. */
const MAX_W = 1280
const MAX_H = 720
/** The model looks at 256 x 256 whatever it is given. */
const SEG = 256
/** The segmenter runs at most this often; frames between reuse the last mask. */
const SEGMENT_EVERY_MS = 45

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

// One direction of a 9-tap gaussian. uFlip=1 reads an uploaded image (row 0 is its top), 0 reads a framebuffer.
const BLUR = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uFlip;
void main() {
  vec2 st = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlip));
  vec2 d = uStep * vec2(1.0, mix(1.0, -1.0, uFlip));
  vec4 c = texture(uTex, st) * 0.2270270270;
  c += (texture(uTex, st + d * 1.3846153846) + texture(uTex, st - d * 1.3846153846)) * 0.3162162162;
  c += (texture(uTex, st + d * 3.2307692308) + texture(uTex, st - d * 3.2307692308)) * 0.0702702703;
  o = c;
}`

const COMPOSITE = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform sampler2D uMask;
void main() {
  vec2 up = vec2(vUv.x, 1.0 - vUv.y);
  float m = smoothstep(0.35, 0.65, texture(uMask, up).r);
  o = vec4(mix(texture(uBlur, vUv).rgb, texture(uSharp, up).rgb, m), 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`)
  return s
}

function program(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const p = gl.createProgram() as WebGLProgram
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag))
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`)
  return p
}

/** Sizes a frame to fit inside MAX_W x MAX_H, keeping its shape, on even numbers. */
export function fitSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, MAX_W / w, MAX_H / h)
  return { w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) }
}

/** The WebGL half: draws one frame blurred behind the person. Owns its canvas. */
class Renderer {
  readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private readonly blur: WebGLProgram
  private readonly composite: WebGLProgram
  private readonly video: WebGLTexture
  private readonly mask: WebGLTexture
  private readonly ping: { tex: WebGLTexture; fbo: WebGLFramebuffer }
  private readonly pong: { tex: WebGLTexture; fbo: WebGLFramebuffer }
  private w = 0
  private h = 0
  private hasMask = false

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL 2 is not available')
    this.gl = gl
    this.blur = program(gl, BLUR)
    this.composite = program(gl, COMPOSITE)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.video = this.texture(gl.LINEAR)
    this.mask = this.texture(gl.LINEAR)
    this.ping = this.target()
    this.pong = this.target()
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private target() {
    const gl = this.gl
    return { tex: this.texture(gl.LINEAR), fbo: gl.createFramebuffer() as WebGLFramebuffer }
  }

  private size(w: number, h: number): void {
    if (w === this.w && h === this.h) return
    const gl = this.gl
    this.w = w
    this.h = h
    this.canvas.width = w
    this.canvas.height = h
    for (const t of [this.ping, this.pong]) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Math.max(2, w >> 2), Math.max(2, h >> 2), 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0)
    }
  }

  setMask(values: Uint8Array): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.mask)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SEG, SEG, 0, gl.RED, gl.UNSIGNED_BYTE, values)
    this.hasMask = true
  }

  /** Draw `frame` blurred behind the person. Before the first mask arrives the whole frame is sharp. */
  draw(frame: TexImageSource, w: number, h: number): void {
    const gl = this.gl
    this.size(w, h)
    const bw = Math.max(2, w >> 2)
    const bh = Math.max(2, h >> 2)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.video)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)

    gl.useProgram(this.blur)
    gl.viewport(0, 0, bw, bh)
    const pass = (from: WebGLTexture, to: { fbo: WebGLFramebuffer }, dx: number, dy: number, flip: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo)
      gl.bindTexture(gl.TEXTURE_2D, from)
      gl.uniform1i(gl.getUniformLocation(this.blur, 'uTex'), 0)
      gl.uniform2f(gl.getUniformLocation(this.blur, 'uStep'), dx, dy)
      gl.uniform1f(gl.getUniformLocation(this.blur, 'uFlip'), flip)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    // Two rounds of horizontal then vertical, at a quarter size: a wide, soft blur for little work.
    pass(this.video, this.ping, 1 / bw, 0, 1)
    pass(this.ping.tex, this.pong, 0, 1 / bh, 0)
    pass(this.pong.tex, this.ping, 1.5 / bw, 0, 0)
    pass(this.ping.tex, this.pong, 0, 1.5 / bh, 0)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.composite)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.video)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.pong.tex)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.mask)
    gl.uniform1i(gl.getUniformLocation(this.composite, 'uSharp'), 0)
    gl.uniform1i(gl.getUniformLocation(this.composite, 'uBlur'), 1)
    gl.uniform1i(gl.getUniformLocation(this.composite, 'uMask'), 2)
    if (!this.hasMask) this.setMask(new Uint8Array(SEG * SEG).fill(255))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
  }
}

type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
interface Insertable {
  MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
  MediaStreamTrackGenerator: new (init: { kind: 'video' }) => VideoGenerator
}

/** Whether the page itself can read and write video frames (not Safari, not Firefox). */
export const hasInsertableStreams = (): boolean =>
  typeof (globalThis as unknown as Partial<Insertable>).MediaStreamTrackProcessor === 'function' &&
  typeof (globalThis as unknown as Partial<Insertable>).MediaStreamTrackGenerator === 'function'

async function loadSegmenter(): Promise<ImageSegmenter> {
  const { ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const fileset = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl }
  const make = (delegate: 'GPU' | 'CPU') =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  try {
    return await make('GPU')
  } catch (err) {
    console.warn('blur: GPU segmenter unavailable, using the CPU', err)
    return make('CPU')
  }
}

export class BlurPipeline {
  /** The blurred picture, to publish in place of the raw camera. */
  readonly track: MediaStreamTrack
  private stopped = false
  private readonly stopFns: Array<() => void> = []

  private constructor(track: MediaStreamTrack) {
    this.track = track
  }

  static async create(input: MediaStreamTrack, opts: { path?: 'auto' | 'canvas' } = {}): Promise<BlurPipeline> {
    const [segmenter, renderer] = await Promise.all([loadSegmenter(), Promise.resolve(new Renderer())])
    const small = document.createElement('canvas')
    small.width = SEG
    small.height = SEG
    const small2d = small.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    let lastSegment = 0
    const u8 = new Uint8Array(SEG * SEG)

    /** Update the mask from `frame` unless one was made a moment ago. */
    const segment = (frame: CanvasImageSource, now: number) => {
      if (now - lastSegment < SEGMENT_EVERY_MS) return
      lastSegment = now
      small2d.drawImage(frame, 0, 0, SEG, SEG)
      segmenter.segmentForVideo(small, now, (result) => {
        const masks = result.confidenceMasks
        const m = masks?.[masks.length - 1]
        if (!m) return
        const f = m.getAsFloat32Array()
        for (let i = 0; i < f.length && i < u8.length; i++) u8[i] = Math.max(0, Math.min(255, Math.round((f[i] as number) * 255)))
        renderer.setMask(u8)
      })
    }

    const useProcessor = hasInsertableStreams() && opts.path !== 'canvas'
    let output: MediaStreamTrack
    const stopFns: Array<() => void> = [() => segmenter.close()]

    if (useProcessor) {
      const g = globalThis as unknown as Insertable
      const processor = new g.MediaStreamTrackProcessor({ track: input })
      const generator = new g.MediaStreamTrackGenerator({ kind: 'video' })
      const transform = new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, controller) {
          try {
            const { w, h } = fitSize(frame.displayWidth, frame.displayHeight)
            const now = performance.now()
            segment(frame, now)
            renderer.draw(frame, w, h)
            controller.enqueue(new VideoFrame(renderer.canvas, { timestamp: frame.timestamp }))
          } finally {
            frame.close()
          }
        },
      })
      const abort = new AbortController()
      processor.readable
        .pipeThrough(transform)
        .pipeTo(generator.writable, { signal: abort.signal })
        .catch(() => {})
      stopFns.push(
        () => abort.abort(),
        () => generator.stop(),
      )
      output = generator
    } else {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = new MediaStream([input])
      await video.play().catch(() => {})
      await new Promise<void>((resolve) => {
        if (video.videoWidth > 0) resolve()
        else video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      })
      // Safari only produces captured frames from a canvas that is in the document.
      renderer.canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
      document.body.appendChild(renderer.canvas)
      const { w, h } = fitSize(video.videoWidth, video.videoHeight)
      renderer.draw(video, w, h)
      const captured = renderer.canvas.captureStream(30)
      output = captured.getVideoTracks()[0] as MediaStreamTrack
      let alive = true
      const tick = () => {
        if (!alive) return
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const size = fitSize(video.videoWidth, video.videoHeight)
          segment(video, performance.now())
          renderer.draw(video, size.w, size.h)
        }
        schedule()
      }
      const schedule = () => {
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(tick)
        else requestAnimationFrame(tick)
      }
      schedule()
      stopFns.push(
        () => {
          alive = false
        },
        () => {
          video.srcObject = null
          renderer.canvas.remove()
          output.stop()
        },
      )
    }

    const pipeline = new BlurPipeline(output)
    pipeline.stopFns.push(...stopFns)
    return pipeline
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const fn of this.stopFns) {
      try {
        fn()
      } catch {
        // Stopping is best effort.
      }
    }
  }
}
