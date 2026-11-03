const ONES = { zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "fifteen" -> 15, "twenty five" -> 25, "a hundred and twenty" -> 120, "12" -> 12. */
export function wordsToNumber(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).toLowerCase().replace(/-/g, ' ').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const w of t.split(/\s+/)) {
    if (w === 'and') continue;
    if (ONES[w] !== undefined) { cur += ONES[w]; seen = true; }
    else if (TENS[w] !== undefined) { cur += TENS[w]; seen = true; }
    else if (w === 'hundred') { cur = (cur || 1) * 100; seen = true; }
    else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}

export const NUMBER_WORDS = '(?:\\d+(?:\\.\\d{1,2})?|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)(?:[\\s-]+(?:and[\\s-]+)?)?)+)';
