// Compact Russian stemmer (Porter/Snowball algorithm for Russian —
// https://snowballstem.org/algorithms/russian/stemmer.html), applied only
// to keyword-search QUERY terms, never to stored article text (see
// db.ts's tokenizeSearchQuery). Users type whole words but articles
// contain every grammatical inflection, so a literal LIKE '%кабели%'
// misses "кабеля"/"кабелей"/"кабелем" in the same article; stemming the
// query to a common root ("кабел") lets one search term match all of
// them via a shorter, more permissive LIKE pattern.
//
// Latin/other non-Cyrillic terms are passed through unstemmed (just
// lowercased) — English stemming isn't attempted, since it would
// mangle product names ("Windows", "Gemini") that must match exactly.

const VOWELS = "аеиоуыэюя";

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch);
}

// RV = the part of the word after its first vowel — the region every
// suffix-stripping step below is restricted to (a suffix "found" is only
// removed if the entire match lies within this tail).
function rvStart(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (isVowel(word[i])) return i + 1;
  }
  return word.length;
}

// R1/R2 = the region after the first/second "vowel immediately followed
// by a non-vowel" — used to scope the derivational (-ость/-ост) ending to
// R2 only, so it doesn't fire too eagerly near the start of short words.
function nextRegionStart(word: string, from: number): number {
  for (let i = from; i < word.length - 1; i++) {
    if (isVowel(word[i]) && !isVowel(word[i + 1])) return i + 2;
  }
  return word.length;
}

function longestSuffix(s: string, endings: readonly string[]): string | null {
  let best: string | null = null;
  for (const e of endings) {
    if (s.endsWith(e) && (best === null || e.length > best.length)) best = e;
  }
  return best;
}

function stripSuffix(s: string, endings: readonly string[]): string | null {
  const match = longestSuffix(s, endings);
  return match === null ? null : s.slice(0, s.length - match.length);
}

// Same as stripSuffix, but only applies when the character immediately
// before the matched suffix is one of `precedingChars` (used for the
// endings the Snowball algorithm requires to follow а/я).
function stripSuffixAfter(
  s: string,
  endings: readonly string[],
  precedingChars: string,
): string | null {
  const match = longestSuffix(s, endings);
  if (match === null) return null;
  const beforeIdx = s.length - match.length - 1;
  if (beforeIdx < 0 || !precedingChars.includes(s[beforeIdx])) return null;
  return s.slice(0, s.length - match.length);
}

function longerRemoval(a: string | null, b: string | null): string | null {
  if (a !== null && b !== null) return a.length < b.length ? a : b;
  return a ?? b;
}

const REFLEXIVE = ["ся", "сь"] as const;

const PERFECTIVE_GERUND_PLAIN = ["ившись", "ывшись", "ивши", "ывши", "ив", "ыв"] as const;
const PERFECTIVE_GERUND_AFTER_AYA = ["вшись", "вши", "в"] as const;

const ADJECTIVE = [
  "ее",
  "ие",
  "ые",
  "ое",
  "ими",
  "ыми",
  "ей",
  "ий",
  "ый",
  "ой",
  "ем",
  "им",
  "ым",
  "ом",
  "его",
  "ого",
  "ему",
  "ому",
  "их",
  "ых",
  "ую",
  "юю",
  "ая",
  "яя",
  "ою",
  "ею",
] as const;

const PARTICIPLE_PLAIN = ["ивш", "ывш", "ующ"] as const;
const PARTICIPLE_AFTER_AYA = ["ем", "нн", "вш", "ющ", "щ"] as const;

const VERB_PLAIN = [
  "ила",
  "ыла",
  "ена",
  "ейте",
  "уйте",
  "ите",
  "или",
  "ыли",
  "ей",
  "уй",
  "ил",
  "ыл",
  "им",
  "ым",
  "ены",
  "ить",
  "ыть",
  "ишь",
  "ую",
  "ю",
] as const;
const VERB_AFTER_AYA = [
  "ла",
  "на",
  "ете",
  "йте",
  "ли",
  "й",
  "л",
  "ем",
  "н",
  "ло",
  "но",
  "ет",
  "ют",
  "ны",
  "ть",
  "ешь",
  "нно",
] as const;

const NOUN = [
  "иями",
  "ями",
  "ами",
  "иях",
  "иям",
  "ией",
  "ах",
  "ях",
  "ям",
  "ев",
  "ов",
  "ие",
  "ье",
  "еи",
  "ии",
  "ей",
  "ой",
  "ий",
  "ию",
  "ью",
  "ия",
  "ья",
  "а",
  "е",
  "и",
  "й",
  "ем",
  "ам",
  "ом",
  "о",
  "у",
  "ы",
  "ь",
  "ю",
  "я",
] as const;

const SUPERLATIVE = ["ейше", "ейш"] as const;

function stripPerfectiveGerund(rv: string): string | null {
  return longerRemoval(
    stripSuffix(rv, PERFECTIVE_GERUND_PLAIN),
    stripSuffixAfter(rv, PERFECTIVE_GERUND_AFTER_AYA, "ая"),
  );
}

function stripParticiple(rv: string): string | null {
  return longerRemoval(
    stripSuffix(rv, PARTICIPLE_PLAIN),
    stripSuffixAfter(rv, PARTICIPLE_AFTER_AYA, "ая"),
  );
}

function stripAdjectival(rv: string): string | null {
  const afterAdjective = stripSuffix(rv, ADJECTIVE);
  if (afterAdjective === null) return null;
  const afterParticiple = stripParticiple(afterAdjective);
  return afterParticiple ?? afterAdjective;
}

function stripVerb(rv: string): string | null {
  return longerRemoval(
    stripSuffix(rv, VERB_PLAIN),
    stripSuffixAfter(rv, VERB_AFTER_AYA, "ая"),
  );
}

// The minimum stemmed-term length this module will ever return — below
// this, a stem risks matching unrelated words (e.g. stemming "кода" down
// to "код" is a reasonable, specific root; going further would start
// over-matching short, unrelated words). Enforced as a hard backstop on
// top of the algorithm's own region-scoped rules.
const MIN_STEM_LENGTH = 4;

function stemCyrillicWord(lower: string): string {
  const rv0 = rvStart(lower);
  if (rv0 >= lower.length) return lower; // no vowel at all — nothing to strip

  const stemPrefix = lower.slice(0, rv0);
  let rv = lower.slice(rv0);

  const r1 = nextRegionStart(lower, 0);
  const r2 = nextRegionStart(lower, r1);
  const r2OffsetInRv = Math.max(0, r2 - rv0);

  const gerund = stripPerfectiveGerund(rv);
  if (gerund !== null) {
    rv = gerund;
  } else {
    rv = stripSuffix(rv, REFLEXIVE) ?? rv;
    const adjectival = stripAdjectival(rv);
    if (adjectival !== null) {
      rv = adjectival;
    } else {
      const verb = stripVerb(rv);
      rv = verb ?? stripSuffix(rv, NOUN) ?? rv;
    }
  }

  if (rv.endsWith("и")) rv = rv.slice(0, -1);

  const r2Now = rv.slice(r2OffsetInRv);
  if (r2Now.endsWith("ость")) rv = rv.slice(0, -4);
  else if (r2Now.endsWith("ост")) rv = rv.slice(0, -3);

  if (rv.endsWith("нн")) {
    rv = rv.slice(0, -1);
  } else {
    const superlative = stripSuffix(rv, SUPERLATIVE);
    if (superlative !== null) {
      rv = superlative;
      if (rv.endsWith("нн")) rv = rv.slice(0, -1);
    } else if (rv.endsWith("ь")) {
      rv = rv.slice(0, -1);
    }
  }

  return stemPrefix + rv;
}

const HAS_CYRILLIC = /[а-яё]/;

// Stems a single query term for keyword search. Cyrillic terms are run
// through the Russian stemmer (guarded against over-stemming below
// MIN_STEM_LENGTH — if the result would be shorter, the original term is
// used instead); Latin/other terms are only lowercased, never stemmed.
export function stemSearchTerm(term: string): string {
  const lower = term.toLowerCase();
  if (!HAS_CYRILLIC.test(lower)) return lower;

  const stemmed = stemCyrillicWord(lower);
  return stemmed.length >= MIN_STEM_LENGTH ? stemmed : lower;
}
