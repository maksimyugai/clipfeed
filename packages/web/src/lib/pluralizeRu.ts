// Standard Russian count-noun plural selection. `forms` is [one, few, many]:
// one = ...1 (but not ...11) -> nominative singular ("выжимка"); few = ...2-4
// (but not ...12-14) -> genitive singular / looks like nominative plural
// ("выжимки"); many = everything else, including 0 and the ...11-14
// exception -> genitive plural ("выжимок").
export function pluralizeRu(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}
