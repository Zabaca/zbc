// What each sender is told to send at: the quality step by call size, and the
// share's caps. Pure, so the step can be checked without a page.

import { CAMERA_CAPS, type Kind, type Quality, SCREEN_CAP } from '../../model'

export interface SendPlan {
  maxBitrate: number
  maxFramerate: number
  /** 1 or more: how much to shrink the captured picture to meet the step's size. */
  scaleResolutionDownBy: number
}

/** The sending parameters for a kind, given the picture's captured size. Audio is left alone (null). */
export function sendPlan(kind: Kind, quality: Quality, captured: { width: number; height: number }): SendPlan | null {
  if (kind === 'camera') {
    const cap = CAMERA_CAPS[quality]
    const scale = Math.max(1, captured.width / cap.width, captured.height / cap.height)
    return { maxBitrate: cap.bitrate, maxFramerate: cap.fps, scaleResolutionDownBy: Math.round(scale * 100) / 100 }
  }
  if (kind === 'screen') return { maxBitrate: SCREEN_CAP.bitrate, maxFramerate: SCREEN_CAP.fps, scaleResolutionDownBy: 1 }
  return null
}
