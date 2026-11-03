// Size / variant normalisation so "size medium", "M", "med" and "UK 10" vs "10" line up.
const WORDS = {
  'extra small': 'xs', 'x small': 'xs', xsmall: 'xs', 'x-small': 'xs',
  small: 's', sm: 's',
  medium: 'm', med: 'm', mid: 'm',
  large: 'l', lg: 'l',
  'extra large': 'xl', 'x large': 'xl', xlarge: 'xl', 'x-large': 'xl',
  'xx large': 'xxl', 'xx-large': 'xxl', '2xl': 'xxl',
  'one size': 'one size', onesize: 'one size', os: 'one size',
};

export function normalizeSize(raw) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/^(size|sz|uk|eu|us)\s*/g, '').replace(/^(size|sz|uk|eu|us)\s*/g, '').trim();
  s = s.replace(/[.,!?]+$/, '');
  if (WORDS[s]) return WORDS[s];
  if (/^\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}

export const DEFAULT_VARIANT = 'default';

/**
 * Pick the lot variant a buyer asked for. Returns the variant key, or null if it is
 * ambiguous (several variants and no usable size in the comment).
 */
export function resolveVariant(lot, requested) {
  const keys = lot.variants.map((v) => v.key);
  if (keys.length === 1) return keys[0];
  if (!requested) return null;
  const want = normalizeSize(requested);
  const hit = lot.variants.find((v) => normalizeSize(v.key) === want || normalizeSize(v.label) === want);
  return hit ? hit.key : null;
}

export function variantLabel(lot, key) {
  if (!key || key === DEFAULT_VARIANT) return '';
  const v = lot.variants.find((x) => x.key === key);
  return v ? v.label : key;
}
