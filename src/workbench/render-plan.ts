export interface DynamicScene {
  index: number
  durationMs: number
  captionEn: string
  captionZh: string
  sourceInMs: number
}

export interface DynamicRenderConfiguration {
  width: 1080 | 1920
  height: 1080 | 1920
  frameRate: 30
  transitionMs: number
}

export interface TimelineScene extends DynamicScene {
  startMs: number
  endMs: number
  transitionOutMs: number
  sourceDurationMs: number
  xfadeOffsetMs: number | null
}

export function buildDynamicTimeline(
  scenes: readonly DynamicScene[],
  config: DynamicRenderConfiguration,
): TimelineScene[] {
  validateConfiguration(config)
  validateScenes(scenes)

  let startMs = 0
  return scenes.map((scene, index) => {
    const endMs = startMs + scene.durationMs
    const next = scenes[index + 1]
    const transitionOutMs = next === undefined
      ? 0
      : Math.min(config.transitionMs, scene.durationMs / 4, next.durationMs / 4)
    const timelineScene: TimelineScene = {
      ...scene,
      startMs,
      endMs,
      transitionOutMs,
      sourceDurationMs: scene.durationMs + transitionOutMs,
      xfadeOffsetMs: next === undefined ? null : endMs,
    }
    startMs = endMs
    return timelineScene
  })
}

function validateConfiguration(config: DynamicRenderConfiguration): void {
  const validDimensions = (config.width === 1920 && config.height === 1080)
    || (config.width === 1080 && config.height === 1920)
  if (!validDimensions
    || config.frameRate !== 30
    || !Number.isSafeInteger(config.transitionMs)
    || config.transitionMs < 0
    || config.transitionMs > 400) {
    throw new Error('invalid dynamic render configuration')
  }
}

function validateScenes(scenes: readonly DynamicScene[]): void {
  if (scenes.length < 5
    || scenes.length > 10
    || scenes.some((scene, index) => scene.index !== index
      || !Number.isSafeInteger(scene.durationMs)
      || scene.durationMs < 1_200
      || typeof scene.captionEn !== 'string'
      || scene.captionEn.trim() === ''
      || typeof scene.captionZh !== 'string'
      || scene.captionZh.trim() === ''
      || !Number.isSafeInteger(scene.sourceInMs)
      || scene.sourceInMs < 0)) {
    throw new Error('invalid dynamic scenes')
  }
}
