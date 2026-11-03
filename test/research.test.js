import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { descriptionHtml, shortText } from '../src/adapters/woo/client.js';

process.env.VISION_WINDOW_MS = '0';
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('web research writes the full description; later speech keeps it; the seller’s edits win', async () => {
  let researchCalls = 0;
  const spark = {
    name: 'muse-spark-1.3',
    listing: async (ctx) => ({ json: { title: 'Old game boy', description: 'An old game boy.', price: 40, variants: [], quantity: 1, confidence: 0.9 }, ms: 5 }),
    research: async (ctx) => {
      researchCalls++;
      assert.match(ctx.transcript, /game boy/);
      return { json: { product: 'Nintendo Game Boy DMG-01', brand: 'Nintendo', title: 'Nintendo Game Boy DMG-01 Original, Grey', description: 'The original 1989 Nintendo Game Boy (DMG-01) in grey, with its dot-matrix screen and contrast dial. Works fine.', facts: ['Model: DMG-01', 'Display: 160 x 144 pixels'], sources: [{ title: 'Game Boy - Wikipedia', url: 'https://en.wikipedia.org/wiki/Game_Boy' }, { title: 'bad', url: 'javascript:alert(1)' }], confidence: 0.95 }, ms: 6000, searches: ['Nintendo Game Boy DMG-01'] };
    },
  };
  const { app } = await makeApp({}, { ai: { spark } });
  const lot = app.lots.nextLot();
  app.lots.onSpeech({ text: 'this is an old game boy, works fine, forty pounds' });
  await until(() => lot.researchStage === 'done');
  assert.equal(researchCalls, 1);
  assert.equal(lot.title, 'Nintendo Game Boy DMG-01 Original, Grey');
  assert.match(lot.description, /DMG-01/);
  assert.equal(lot.price, 40); // the seller's price, never the web's
  assert.deepEqual(lot.research.sources.map((x) => x.title), ['Game Boy - Wikipedia']); // only real links
  // more speech re-drafts the listing but must not replace the researched text
  app.lots.onSpeech({ text: 'comes with tetris too' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lot.title, 'Nintendo Game Boy DMG-01 Original, Grey');
  assert.match(lot.description, /dot-matrix/);
  // the seller's own words always win
  app.lots.override(lot.id, { description: 'My own words.' });
  assert.equal(lot.descriptionSource, 'seller');
  app.lots.researchAgain(lot.id);
  await until(() => researchCalls === 2 && lot.researchStage === 'done');
  assert.equal(lot.description, 'My own words.');
  // shop page gets the description plus the specs
  const html = descriptionHtml({ ...lot, description: 'A <b>great</b> console.' });
  assert.match(html, /<li>Model: DMG-01<\/li>/);
  assert.match(html, /&lt;b&gt;great/);
  assert.ok(shortText('First sentence here is long enough to count as a real sentence. Second sentence goes on and on and on.', 80).endsWith('sentence.'));
});
