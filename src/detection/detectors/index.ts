import type { ChannelDetector } from '../types'
import { momDetector } from './mom'
import { passthroughDetector } from './passthrough'

/**
 * Detector registry, keyed by TargetAccount.detectorKey.
 *
 * Adding a channel means adding a detector here and setting the target's
 * detectorKey — no change to the pipeline, the governor, or the dashboard.
 * Phase 1.5's semantic ViralBhayaniDetector slots in as one more entry.
 */
const REGISTRY: Record<string, ChannelDetector> = {
  [momDetector.key]: momDetector,
  [passthroughDetector.key]: passthroughDetector,
}

/**
 * Unknown keys fall back to passthrough rather than throwing. A target
 * mis-configured in the DB should still have its posts recorded; going silent
 * would be the worse failure.
 */
export function getDetector(key: string | null | undefined): ChannelDetector {
  if (key && REGISTRY[key]) return REGISTRY[key]
  return passthroughDetector
}

export function listDetectors(): ChannelDetector[] {
  return Object.values(REGISTRY)
}

export { momDetector, passthroughDetector }
