// Writes src/lib/google-fonts.json, the Look screen's list of Google Fonts
// families, from Google's public font metadata (no API key). Run it by hand
// when Google adds families; never part of the Worker's build.
//
//   bun run --cwd apps/web fonts:catalogue
//
// Each entry is [family, category, whether it covers Arabic], most used
// first. Only names the deployment can copy (letters, digits and spaces) are
// kept.
import { writeFileSync } from 'node:fs'

const METADATA = 'https://fonts.google.com/metadata/fonts'
const FAMILY = /^[A-Za-z0-9 ]{1,64}$/

interface Family {
  readonly family: string
  readonly category: string
  readonly subsets: readonly string[]
  readonly popularity: number
}

const response = await fetch(METADATA)
if (!response.ok) {
  console.error(`google-fonts: ${METADATA} answered ${response.status}`)
  process.exit(1)
}
// Google has prefixed this JSON with )]}' before; skip anything before it.
const text = await response.text()
const { familyMetadataList: families } = JSON.parse(
  text.slice(text.indexOf('{')),
) as { familyMetadataList: readonly Family[] }

const kept = families
  .filter((entry) => FAMILY.test(entry.family))
  .sort(
    (a, b) =>
      a.popularity - b.popularity || a.family.localeCompare(b.family, 'en'),
  )

const lines = kept.map((entry) =>
  JSON.stringify([
    entry.family,
    entry.category,
    entry.subsets.includes('arabic'),
  ]).replaceAll(',', ', '),
)
writeFileSync(
  new URL('../src/lib/google-fonts.json', import.meta.url),
  `[\n  ${lines.join(',\n  ')}\n]\n`,
)
console.log(
  `google-fonts: ${kept.length} families written, ${families.length - kept.length} skipped`,
)
