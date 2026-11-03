import { shortText } from '../adapters/woo/client.js';
// Buyer-facing message templates. Kept short: they land in Messenger / IG DMs on a phone.

const firstName = (n) => String(n || '').replace(/^@/, '@').split(' ')[0] || 'there';
const money = (sym, n) => `${sym}${Number(n || 0).toFixed(Number(n) % 1 ? 2 : 0)}`;

export function payLinkText({ claim, lot, order, sym, ttlMin, variantLabel, bundledCount, promoted }) {
  const item = `Lot ${lot.lotNumber} · ${lot.title}${variantLabel ? ` (${variantLabel})` : ''}${claim.qty > 1 ? ` ×${claim.qty}` : ''}`;
  if (promoted) {
    return `🎉 Good news ${firstName(claim.displayName)}! ${item} is yours, because the earlier buyer didn't pay. We're holding it for ${ttlMin} min. Tap to pay ${money(sym, order.total)}.`;
  }
  if (bundledCount > 1) {
    return `✅ Added ${item} · ${money(sym, lot.price * claim.qty)} to your order. ${bundledCount} items, ${money(sym, order.total)} total. Same checkout, pay within ${ttlMin} min.`;
  }
  return `✅ It's yours, ${firstName(claim.displayName)}! ${item} · ${money(sym, lot.price * claim.qty)}. We're holding it for ${ttlMin} min. Tap to pay.`;
}

export const payButtonTitle = (sym, total) => `Pay ${money(sym, total)}`.slice(0, 20);

export const waitlistPublicText = ({ claim, lot, position }) =>
  `${firstName(claim.displayName)} you're #${position} on the waitlist for Lot ${lot.lotNumber}. If it frees up we'll message you a pay link 🤞`;

export const whichSizeText = ({ claim, lot }) =>
  `${firstName(claim.displayName)} which size? Lot ${lot.lotNumber} comes in ${lot.variants.map((v) => v.label).join(', ')}. Comment e.g. "lot ${lot.lotNumber} size ${lot.variants[0].label}"`;

export const soldOutText = ({ claim, lot, position }) =>
  `Sorry ${firstName(claim.displayName)}, Lot ${lot.lotNumber} (${lot.title}) sold out. You were #${position} on the waitlist. Thanks for watching, see you next show 💛`;

/** Caption for the post LiveLot publishes for a lot in post mode. */
export function lotCaption({ lot, sym }) {
  const multi = lot.variants.length > 1 || (lot.variants[0] && lot.variants[0].key !== 'default');
  const total = Object.values(lot.initialStock || {}).reduce((a, n) => a + n, 0);
  const lines = [
    `Lot ${lot.lotNumber}: ${lot.title} · ${money(sym, lot.price)}`,
    shortText(lot.description, 280),
    multi ? `Sizes: ${lot.variants.map((v) => v.label).join(', ')}` : total > 1 ? `${total} available` : 'One available',
    '',
    multi ? `Comment SOLD + your size to buy (e.g. "sold ${lot.variants[0].label}").` : 'Comment SOLD to buy.',
    'First comment wins. Your pay link arrives by private message.',
  ];
  return lines.filter((l, i) => l !== '' || i === 3).join('\n');
}

export { money };
