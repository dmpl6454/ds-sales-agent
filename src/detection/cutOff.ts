/**
 * cutOff.ts — the words for an answer whose body was cut off, in ONE place, with no imports, so the
 * transport that writes them (igHttp.ts `cutAnswer`) and the page that must not quote them as
 * Instagram's or Meta's own words (view-model/detection-outage.ts `quoteOf`) cannot drift apart.
 * A view model must never import the transport itself: it pulls `node:https` toward the page bundle.
 */
export const CUT_OFF_MARKER = "the answer's body was cut off"

/** PURE. Is this recorded head our own note about a cut-off body, rather than the remote's words? */
export function isCutOffHead(head: string | null | undefined): boolean {
  return typeof head === 'string' && head.replace(/^\[@[^\]]+\]\s*/, '').trimStart().startsWith(CUT_OFF_MARKER)
}
