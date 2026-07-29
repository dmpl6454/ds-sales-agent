'use client'

import { useTransition } from 'react'
import { labelCampaign } from '../actions'

/**
 * One-tap answer to a REVIEW item. The label is recorded in RuleFeedback so
 * detector precision can be measured over time rather than assumed.
 */
export function ReviewButtons({ campaignId }: { campaignId: string }) {
  const [pending, start] = useTransition()
  return (
    <div className="btnrow">
      <button disabled={pending} onClick={() => start(() => labelCampaign(campaignId, true))}>
        Paid
      </button>
      <button disabled={pending} onClick={() => start(() => labelCampaign(campaignId, false))}>
        Not paid
      </button>
    </div>
  )
}
