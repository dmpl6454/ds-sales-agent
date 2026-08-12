import type { ChannelDetector } from '../types'
import { momDetector } from './mom'
import { passthroughDetector } from './passthrough'
import { semanticDetector } from './semantic'

/**
 * Detector registry, keyed by TargetAccount.detectorKey.
 *
 * Adding a channel means adding a detector here and setting the target's
 * detectorKey — no change to the pipeline, the governor, or the dashboard.
 *
 *   mom          #Collaboration rules. Exact, for the one publisher that discloses.
 *   semantic     reads the caption and judges. For channels that disclose nothing.
 *   passthrough  stores and classifies nothing. The honest default for a channel
 *                whose behaviour we have not established.
 */
const REGISTRY: Record<string, ChannelDetector> = {
  [momDetector.key]: momDetector,
  [passthroughDetector.key]: passthroughDetector,
  [semanticDetector.key]: semanticDetector,
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

export { momDetector, passthroughDetector, semanticDetector }
