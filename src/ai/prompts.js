// Prompts shared by Muse Spark 1.3 (Meta Model API) and Muse Spark Open (Baseten).

export const GLANCE = (said = '') => `You watch a seller on camera. Look at this frame.
Is the seller holding up or showing an item to sell? Look at their hands first: small items count (a remote, phone, mug, ring, shoe).
Ignore the room: wall pictures, furniture, shelves and decorations are not the item.${said ? `
The seller just said: "${said.slice(-300)}". Use it to name the item if it is visible.` : ''}
If nobody is holding or showing an item, reply holding=false and noun=null.
Reply with JSON only:
{"holding": true|false,
 "noun": "<2-3 word concrete noun phrase for image segmentation, e.g. 'denim jacket', 'white trainers', 'blue mug'>",
 "label": "<short shop-style name, e.g. 'Levi's denim trucker jacket'>",
 "colors": ["<main colours>"],
 "brand": "<brand if clearly visible, else null>",
 "confidence": 0.0-1.0}`;

export const LISTING = (ctx) => `You turn what a live seller says and shows into a shop listing.
Seller's words (speech transcript, may contain recognition errors; two listeners may each give the same words, and one can catch what the other missed):
"""${ctx.transcript || '(nothing said yet)'}"""
Vision hint: ${ctx.label || ctx.noun || 'unknown item'}${ctx.colors?.length ? ` (${ctx.colors.join(', ')})` : ''}${ctx.brand ? `, brand ${ctx.brand}` : ''}.
Currency: ${ctx.currency}.

Rules:
- Price: only a price the seller actually said. If none was said, null.
- Sizes/variants: only ones the seller said (e.g. "sizes 9 and 10", "medium"). Per-size quantity if they said it, else 1.
- Quantity: total units if they said e.g. "I've got three of these", else 1.
- Title: max 60 chars, specific (brand, item, colour). If the seller names the brand or model, use it even if the picture doesn't show it. Description: 1-2 sentences, honest, mention condition if said.
- If you can't tell what the item is, title and noun are null. Never write placeholders like "Awaiting details".
- noun: a 1-3 word noun phrase for finding the item in a photo (e.g. "tv remote", "denim jacket", "blue mug").
Reply with JSON only:
{"title": "...", "noun": "...", "description": "...", "price": number|null, "variants": [{"label": "M", "qty": 1}], "quantity": 1, "condition": "new|like new|used|null", "confidence": 0.0-1.0}`;

export const RESEARCH = (ctx) => `You help a small seller list this item in their online shop. Look at the photo, then use web search to identify the exact product and check its details.
What the seller said (speech transcript, may contain errors; two listeners may each give the same words, and one can catch what the other missed): """${ctx.transcript || '(nothing yet)'}"""
What the camera AI saw: ${ctx.label || ctx.noun || 'unknown'}${ctx.brand ? `, brand ${ctx.brand}` : ''}${ctx.colors?.length ? `, colours ${ctx.colors.join(', ')}` : ''}.

Rules:
- If the seller names the brand or model, trust that and search for it. Otherwise identify brand, model, edition and colour only as far as the photo and your search support. If you can't pin the exact model, describe the kind of item honestly and lower confidence.
- description: 60-120 words in plain, friendly British English for a shop page: what it is, the features and specs a buyer cares about, and the condition ONLY as the seller described it (otherwise don't mention condition). No hype, no invented facts, no price, no shipping promises. Write for shoppers: never mention the photo, the camera, or what you couldn't identify.
- title: max 70 characters, specific (brand, model, colour).
- facts: up to 8 short spec lines ("Display: 160 x 144 pixels").
- sources: up to 3 pages you relied on.
Reply with JSON only:
{"product": "...", "brand": "<brand, or null if unknown>", "title": "...", "description": "...", "facts": ["..."], "sources": [{"title": "...", "url": "https://..."}], "confidence": 0.0-1.0}`;

export const CLASSIFY = (ctx) => `You read comments on a Facebook/Instagram live shopping stream and decide if a comment is a purchase claim.
A claim means the viewer wants to buy now: "sold", "mine", "I'll take it", "dibs", "sold lot 3", "size 10 please", "I want the blue one".
NOT a claim: questions ("is it sold?", "how much?", "what size?"), "sold out", greetings, compliments, chit-chat.
${ctx.currentLot ? `Item on screen now: Lot ${ctx.currentLot.lotNumber} "${ctx.currentLot.title || ctx.currentLot.concept || ''}"${ctx.currentLot.sizes ? `, sizes ${ctx.currentLot.sizes}` : ''}.` : ''}
Comment: """${ctx.text}"""
Reply with JSON only:
lot_number: ONLY if the viewer wrote a lot number in the comment (e.g. "lot 3", "#3"); otherwise null, even if a lot is on screen.
{"is_claim": true|false, "confidence": 0.0-1.0, "lot_number": int|null, "size": "string|null", "quantity": int, "description": "<item description the viewer used, e.g. 'blue mug', else null>"}`;

export const MATCH = (ctx) => `A live-shopping viewer commented: """${ctx.text}"""
They described the item as "${ctx.description}". Which lot do they mean?
Lots recently shown (most recent last):
${ctx.lots.map((l) => `- Lot ${l.lotNumber}: ${l.title || l.concept || 'untitled'}${l.colors?.length ? ` [${l.colors.join(', ')}]` : ''}${l.sizes ? ` sizes ${l.sizes}` : ''}`).join('\n')}
Reply with JSON only: {"lot_number": int|null, "confidence": 0.0-1.0, "reason": "<short>"}`;

export const RECAP = (ctx) => `Write a short, upbeat post-show recap for a small online shop's social post.
Stats: ${JSON.stringify(ctx)}
Max 220 characters, 1-2 emojis, no hashtags spam (max 2). Reply with JSON only: {"text": "..."}`;

// An uploaded photo: nobody is holding anything, the item is the subject.
export const GLANCE_PHOTO = (said = '') => `A seller took this photo of an item they want to sell. Name the main item in it (ignore the background, table, floor and anything that is clearly not for sale).${said ? `
The seller said: "${said.slice(-300)}". Use it to name the item.` : ''}
Reply with JSON only:
{"holding": true,
 "noun": "<2-3 word concrete noun phrase for image segmentation, e.g. 'game console', 'white trainers', 'blue mug'>",
 "label": "<short shop-style name>",
 "colors": ["<main colours>"],
 "brand": "<brand if clearly visible, else null>",
 "confidence": 0.0-1.0}`;
