import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captionEntities, splitCamel } from '@/detection/captionEntities'

/**
 * EVERY PERSON AND COMPANY A PAID POST NAMES — 2026-08-25.
 *
 * The two captions below are VERBATIM from @taranadarsh, supplied by Tabish with the
 * complaint: *"multiple individuals, brands were named, none of which have been discovered as
 * targets with verified accounts to be messaged."*
 *
 * What the system had stored for them:
 *
 *   Toxic    brands: ["Toxic","KGF2"]      — 2 names, both the film
 *   Haiwaan  brands: ["Haiwaan"]           — 1 name, the film
 *
 * Both were correctly detected as CAMPAIGN. The gap was never detection; it was that
 * `semantic.ts` asks the model for "commercial entities being promoted", and for a film
 * release that is the film — while the people who buy placement are the cast, the director
 * and the production house.
 *
 * These fixtures are the acceptance criteria, and they are asserted by NAME rather than by
 * count so that a change which finds ten different things cannot pass by arithmetic.
 */

const TOXIC = `4 YEARS AFTER 'KGF 2', YASH RETURNS WITH 'TOXIC' – IN CINEMAS *TOMORROW*... Four years after the historic success of #KGF2, #Yash returns to the big screen with #Toxic – and the response to the advance bookings has been PHENOMENAL.

🔗: https://linktr.ee/ToxicMovieBookings

#Toxic also features #Nayanthara, KiaraAdvani, TaraSutaria, RukminiVasanth, and HumaQureshi in pivotal characters.

Directed by Geetu Mohandas and jointly produced by Venkat K Narayana and Yash, Toxic arrives in cinemas worldwide on [Wednesday] 26 Aug 2026.

ToxicAFairyTaleForGrownups | KVNProductions | MonsterMindCreations | ToxicTheMovie | DaddyIsHome | ToxicOn26thAug`

const HAIWAAN = `AKSHAY KUMAR - SAIF ALI KHAN REUNITE AFTER 18 YEARS FOR PRIYADARSHAN'S 'HAIWAAN' – TRAILER OUT NOW – 11 SEPT 2026 RELEASE... The chase begins... The #HaiwaanTrailer is now LIVE, offering a glimpse into the intense face-off between the hero and the #Haiwaan.

⭐ #HaiwaanTrailer 🔗: https://youtu.be/Bm5S7ZKk6K8?si=5QRVLlD7ztZa72yw

Starring #AkshayKumar and #SaifAliKhan, who reunite on the big screen after 18 years, Haiwaan is set for a worldwide theatrical release on 11 Sept 2026.

Directed by Priyadarshan, Haiwaan also features BomanIrani, SaiyamiKher, ShriyaPilgaonkar, and SharibHashmi in pivotal roles.

A KVN Productions and Thespian Films production, Haiwaan is produced by Venkat K Narayana and Shailaja Desai Fenn.

HaiwaanOnSeptember11`

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase())

describe('captionEntities — the Toxic post', () => {
  const found = lower(captionEntities(TOXIC))

  it.each([
    ['Yash', 'yash'],
    ['Nayanthara', 'nayanthara'],
    ['Kiara Advani — a bare CamelCase token, no hash', 'kiara advani'],
    ['Tara Sutaria', 'tara sutaria'],
    ['Rukmini Vasanth', 'rukmini vasanth'],
    ['Huma Qureshi', 'huma qureshi'],
    ['Geetu Mohandas — the DIRECTOR, only reachable via "Directed by"', 'geetu mohandas'],
    ['Venkat K Narayana — the PRODUCER, with a middle initial', 'venkat k narayana'],
    ['KVN Productions — an initialised company name', 'kvn productions'],
    ['Monster Mind Creations', 'monster mind creations'],
  ])('finds %s', (_label, name) => {
    expect(found).toContain(name)
  })

  it('does not swallow the conjunction after a role word', () => {
    /* The first version used `/gi`, which makes `[A-Z]` match lowercase — so "Directed by
       Geetu Mohandas and jointly produced" captured "Geetu Mohandas and jointly". */
    expect(found.some((n) => n.endsWith(' and') || n.includes(' and '))).toBe(false)
  })

  it('refuses the campaign slogans, which resolve to nothing and cost lookups', () => {
    for (const junk of ['toxic the movie', 'daddy is home', 'toxic on 26th aug']) {
      expect(found).not.toContain(junk)
    }
  })
})

describe('captionEntities — the Haiwaan post', () => {
  const found = lower(captionEntities(HAIWAAN))

  it.each([
    ['Akshay Kumar', 'akshay kumar'],
    ['Saif Ali Khan — three words', 'saif ali khan'],
    ['Boman Irani', 'boman irani'],
    ['Saiyami Kher', 'saiyami kher'],
    ['Shriya Pilgaonkar', 'shriya pilgaonkar'],
    ['Sharib Hashmi', 'sharib hashmi'],
    ['Priyadarshan — ONE word, reachable only via "Directed by"', 'priyadarshan'],
    ['Thespian Films', 'thespian films'],
    ['Shailaja Desai Fenn', 'shailaja desai fenn'],
    ['Venkat K Narayana', 'venkat k narayana'],
  ])('finds %s', (_label, name) => {
    expect(found).toContain(name)
  })

  it('refuses ALL-CAPS headline prose', () => {
    /*
      `[A-Z]{2,}` had to be allowed so "KVN Productions" could be found, and it immediately
      also matched these out of the same caption. A wholly upper-case run is headline prose;
      an initialised company is MIXED, which is what separates them.
    */
    for (const junk of ['years after', 'yash returns with', 'saif ali khan reunite', 'years for priyadarshan']) {
      expect(found).not.toContain(junk)
    }
  })
})

describe('captionEntities — the bar it must not lower', () => {
  it('refuses anything under four characters, which is an initialism not a name', () => {
    /* "G9", "UAE", "KGF" each generate seven candidate handles and resolve to nothing. */
    expect(lower(captionEntities('#G9 and #UAE and #KGF are here'))).toEqual([])
  })

  it('never returns a run that is only sentence words', () => {
    expect(captionEntities('The Trailer Is Out Now')).toEqual([])
  })

  it('is total on an empty or absent caption', () => {
    expect(captionEntities('')).toEqual([])
  })

  it('splitCamel keeps a run of capitals together', () => {
    expect(splitCamel('KVNProductions')).toEqual(['KVN', 'Productions'])
    expect(splitCamel('AkshayKumar')).toEqual(['Akshay', 'Kumar'])
  })
})

/**
 * And it must actually be WIRED — the missing-caller failure this repo keeps producing
 * (166 cover frames read by nothing; `taggedHandlesIn` reaching neither path in production).
 * No behavioural test can fail for a caller nobody wrote.
 */
describe('captionEntities reaches discovery', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/detection/officialDiscovery.ts'), 'utf8')

  it('is called by the harvest', () => {
    expect(src).toMatch(/captionEntities\(p\.caption\)/)
  })

  it('is own-mark filtered, so a publisher code cannot enter through the new door', () => {
    /* `fg2`/`bs2` were already refused on the `brands` arm; a second arm needs the same bar. */
    expect(src).toMatch(/const fromEntities = captionEntities\(p\.caption\)\.filter\(\s*\(b\) => !isOwnMark/)
  })

  it('is MERGED with the model brands, not a fallback behind them', () => {
    /* As a fallback it would never run: `brands` is non-empty on almost every paid post. */
    expect(src).toMatch(/fromCaption\.length > 0 \|\| fromEntities\.length > 0/)
    expect(src).toMatch(/\[\.\.\.fromCaption, \.\.\.fromEntities\]/)
  })
})
