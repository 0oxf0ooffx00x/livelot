import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { regexClassify, createClassifier } from '../src/agents/classifier.js';
import { heuristicListing, parsePrice } from '../src/agents/listing.js';
import { extractJson } from '../src/agents/json.js';
import { parseSamBoxes, normalizeBox } from '../src/ai/sam.js';
import { outputText } from '../src/ai/metaClient.js';
import { asrText } from '../src/ai/asr.js';
import { verifySignature, parseWebhook } from '../src/adapters/meta/webhook.js';
import { sseEvents } from '../src/adapters/meta/fbLive.js';
import { normalizeSize, resolveVariant } from '../src/domain/variants.js';
import { buildVariants } from '../src/domain/models.js';

test('regex classifier: claims vs questions', () => {
  const yes = ['sold', 'SOLD!!', 'mine', "I'll take it", 'dibs', 'sold lot 3', '🙋', 'size 10 please', 'sold M', 'me please'];
  const no = ['is it sold?', 'sold out?', 'how much?', 'love it', 'what size is it?', 'already sold?', 'hello from Leeds'];
  for (const t of yes) assert.ok(regexClassify(t).isClaim, t);
  for (const t of no) assert.ok(!regexClassify(t).isClaim, t);
  assert.equal(regexClassify('sold lot 3').lotNumber, 3);
  assert.equal(regexClassify('sold in a medium').size, 'm');
  assert.equal(regexClassify('sold x2').qty, 2);
  assert.equal(regexClassify('sold 10').bareNumber, '10');
  assert.equal(regexClassify("I'll take the blue mug").description, 'blue mug');
});

test('classifier chain falls back to the next model, then regex', async () => {
  const calls = [];
  const bad = { name: 'open', classify: async () => { calls.push('open'); throw new Error('empty content'); } };
  const good = { name: 'spark', classify: async () => { calls.push('spark'); return { json: { is_claim: true, confidence: 0.8, size: 'Medium' } }; } };
  const r = await createClassifier({ models: [bad, good], fastPath: false })('can I get it in medium');
  assert.deepEqual(calls, ['open', 'spark']);
  assert.equal(r.source, 'spark');
  assert.equal(r.size, 'm');
  const r2 = await createClassifier({ models: [bad], fastPath: false })('sold');
  assert.equal(r2.source, 'regex');
  // plain chatter skips the model round trip entirely
  calls.length = 0;
  await createClassifier({ models: [good] })('hello everyone');
  assert.deepEqual(calls, []);
});

test('listing heuristics from seller speech', () => {
  const a = heuristicListing("Lot one, this is a Levi's trucker jacket, size M, fifteen pounds");
  assert.equal(a.price, 15);
  assert.deepEqual(a.variants.map((v) => v.label), ['M']);
  const b = heuristicListing('Next up white Nike trainers, sizes 9 and 10, £25 each');
  assert.equal(b.price, 25);
  assert.deepEqual(b.variants.map((v) => v.label), ['9', '10']);
  assert.ok(b.variants.every((v) => v.qty === 1));
  const c = heuristicListing("This is a blue ceramic mug, I've got three of these, eight pounds");
  assert.equal(c.quantity, 3);
  assert.equal(c.price, 8);
  assert.equal(parsePrice('twenty five quid'), 25);
  assert.equal(parsePrice('£12.50'), 12.5);
});

test('extractJson survives fences, prose, think tags and trailing commas', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a": {"b": "}"}, } done'), { a: { b: '}' } });
  assert.deepEqual(extractJson('<think>hmm {"x":0}</think>{"is_claim": true,}'), { is_claim: true });
  assert.throws(() => extractJson(''));
});

test('SAM box tokens parse and normalise', () => {
  const out = '<|box;x1=100;y1=50;x2=500;y2=650;w=1280;h=720|><|mask;rle=abc|>\n<|box;x1=0.1;y1=0.2;x2=0.3;y2=0.4;score=0.9|>';
  const boxes = parseSamBoxes(out);
  assert.equal(boxes.length, 2);
  const n = normalizeBox(boxes[0], 1280, 720);
  assert.ok(Math.abs(n.x2 - 500 / 1280) < 1e-9);
  assert.ok(Math.abs(n.y2 - 650 / 720) < 1e-9);
  const n2 = normalizeBox(boxes[1], 1280, 720);
  assert.equal(n2.x1, 0.1);
  assert.equal(boxes[1].confidence, 0.9);
  assert.deepEqual(parseSamBoxes('no matches'), []);
});

test('model output text extraction across response shapes', () => {
  assert.equal(outputText({ output_text: 'hi' }), 'hi');
  assert.equal(outputText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }), 'a\nb');
  assert.equal(outputText({ choices: [{ message: { content: 'c' } }] }), 'c');
  assert.equal(asrText({ text: ' hello ' }), 'hello');
  assert.equal(asrText({ segments: [{ text: 'a' }, { text: 'b' }] }), 'a b');
});

test('webhook signature check and payload parsing', () => {
  const secret = 's3cret';
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ changes: [{ field: 'live_comments', value: { id: 'ig1', text: 'sold', from: { id: '9', username: 'amy' }, media: { id: 'm1' } } }] }] }));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(verifySignature(body, sig, secret));
  assert.ok(!verifySignature(body, sig.replace(/.$/, '0'), secret));
  assert.ok(!verifySignature(body, undefined, secret));
  const { comments } = parseWebhook(JSON.parse(body));
  assert.equal(comments[0].platform, 'instagram');
  assert.equal(comments[0].from.name, '@amy');
  const fb = parseWebhook({ object: 'page', entry: [{ changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', message: 'mine', from: { id: '1', name: 'Al' } } }], messaging: [{ sender: { id: 'psid1' }, message: { text: 'hi' } }] }] });
  assert.equal(fb.comments[0].text, 'mine');
  assert.equal(fb.messages[0].psid, 'psid1');
});

test('SSE parser yields JSON events and skips keep-alives', async () => {
  const enc = new TextEncoder();
  async function* body() {
    yield enc.encode('data: {"id":"1","message":"so');
    yield enc.encode('ld"}\n\n: ping\n\ndata: {"id":"2","message":"mine"}\n\n');
  }
  const got = [];
  for await (const e of sseEvents(body())) got.push(e.id);
  assert.deepEqual(got, ['1', '2']);
});

test('sizes normalise and resolve', () => {
  assert.equal(normalizeSize('Medium'), 'm');
  assert.equal(normalizeSize('size 10'), '10');
  assert.equal(normalizeSize('UK 9'), '9');
  const lot = { variants: buildVariants({ variants: [{ label: 'S' }, { label: 'M' }] }).variants };
  assert.equal(resolveVariant(lot, 'medium'), 'm');
  assert.equal(resolveVariant(lot, null), null);
  assert.equal(resolveVariant({ variants: [{ key: 'default' }] }, null), 'default');
});

test('real SAM 3.1 output (captured 31 Oct 2026) parses with pixel coords and c= confidence', () => {
  const real = '<0f>0<|box;x1=462;y1=27;x2=1562;y2=1148;w=2096;h=1152;c=0.949367105960846|><|mask;x=0;y=0;c=0.949367105960846;data=1024,1005,!!!!1N?G+LY2A|>';
  const [b] = parseSamBoxes(real);
  assert.equal(b.confidence, 0.949367105960846);
  const n = normalizeBox(b, 999, 999); // w/h in the token win over the passed size
  assert.ok(Math.abs(n.x1 - 462 / 2096) < 1e-9 && Math.abs(n.y2 - 1148 / 1152) < 1e-9);
});

test('a model-invented lot number is ignored; a typed one is kept', async () => {
  const { mergeModel } = await import('../src/agents/classifier.js');
  const m = (text, json) => { const rx = regexClassify(text); rx.text = text; return mergeModel(json, rx, 'spark').lotNumber; };
  assert.equal(m('sold!', { is_claim: true, lot_number: 2 }), null);
  assert.equal(m('can I get the 10s?', { is_claim: true, lot_number: 2, size: '10' }), null);
  assert.equal(m('need #12 pls', { is_claim: true, lot_number: 12 }), 12);
});

test('fast path answers obvious claims without the model; ambiguous comments go to it', async () => {
  let calls = 0;
  const model = { name: 'spark', classify: async () => { calls++; return { json: { is_claim: true, confidence: 0.9 } }; } };
  const c = createClassifier({ models: [model], fastPath: true });
  for (const t of ['sold!', 'mine', 'SOLD lot 3', 'sold M']) assert.match((await c(t)).source, /fast path/);
  assert.equal(calls, 0);
  for (const t of ['can I get the 10s?', "I'll take the blue mug", 'is it sold?']) assert.equal((await c(t)).source, 'spark');
  assert.equal(calls, 3);
  assert.equal((await c('love it')).source, 'regex');
  assert.equal(calls, 3);
});
