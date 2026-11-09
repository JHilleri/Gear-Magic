// Tiny text helpers shared by the sim's log lines and the UI (no deps).

/** "a Farm", "an Iron Mine", "an Archer": the indefinite article for a display name. */
export function aOrAn(word: string): string {
  const w = word.trim();
  const lower = w.toLowerCase();
  // Vowel letters that sound like a consonant ("a Unicorn", "a One-…") and silent h ("an Hour").
  const consonantSound = /^(uni|use|usu|one|eu)/.test(lower);
  const vowelSound = /^(hour|honou?r|heir)/.test(lower);
  const an = vowelSound || (!consonantSound && /^[aeiou]/.test(lower));
  return `${an ? 'an' : 'a'} ${w}`;
}
