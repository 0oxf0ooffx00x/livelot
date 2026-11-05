# LiveLot

**Sell on Facebook and leave the listings to Meta's Muse models.** Selling on social media means hours of admin for every item: cropping photos, writing descriptions, creating shop listings, then chasing buyers through comments and private messages. With LiveLot, you show an item to your camera or upload a photo and say the price. The Muse models cut the item out, clean up the photo and write the listing. You check it and publish, and LiveLot posts it to your Facebook Page and adds it to your WooCommerce store. The first person to comment "sold" gets a private message with a pay link. The last unit can't be sold twice, unpaid holds go to the next person in line, and every buyer's items are bundled into one checkout.

Facebook Live and Instagram are built too, but haven't been run on real accounts yet. See [What's been tested](#whats-been-tested).

Built for the **Meta Global AI Developer Hackathon**, Indie Developer track, problem statement **Build for Your World**.

## Built during the hackathon

**Everything in this repository was written during the hackathon build period (27 Oct – 4 Nov 2026).** The project started from an empty folder on 31 Oct 2026. [`PLAN.md`](PLAN.md) was written first, then the code. No earlier product or codebase sits underneath it. `PLAN.md` is kept as the working plan and build log: the API facts we verified, the problems we hit (such as Meta's 100-follower rule for going live) and what we changed because of them.

New for the hackathon, all of it:

| Part | Where |
|---|---|
| Server: claim engine, lot pipeline, AI agents, Meta and WooCommerce adapters, Settings, Facebook Connect | `src/` |
| Seller screens: dashboard, Settings, studio, OBS overlay, pay page, recap card | `public/` |
| Icon art and the scripts that cut and clean it | `art/`, `scripts/art-*.js`, `public/art/` |
| WooCommerce helper plugin | `woo-plugin/` |
| Deployment: Cloud Run script, Cloudflare Worker, store setup on a VM | `deploy/`, `scripts/` |
| Tests and the scripted demo show | `test/`, `fixtures/` |

**Not ours, used as-is:**
- **Meta:** the Meta Model API models listed below, plus the Facebook Graph, Messenger and Instagram APIs.
- **npm packages:** [express](https://expressjs.com) (MIT) and, optionally, [sharp](https://sharp.pixelplumbing.com) (Apache-2.0) for cropping. They're installed from npm and not copied into this repo.
- **The test store:** WordPress, WooCommerce, MariaDB and Caddy. `deploy/shop/` pulls their official Docker images; none of their code is in this repo.
- **Hosting:** Google Cloud Run and Compute Engine, and Cloudflare Workers.
- **Icons:** generated for this project with ChatGPT and Gemini image generation from our prompts in `art/PROMPTS.txt`, then cut out and cleaned by our scripts. There is no stock art or third-party imagery; the demo images in `fixtures/img/` are hand-written SVG.

### Meta AI in LiveLot

| Meta model or API | What LiveLot uses it for |
|---|---|
| **Muse Spark 1.3**, vision | Names the item the seller is holding up, or the main item in a phone photo |
| **Muse Spark 1.3** with the **web search** tool | Identifies the exact product (brand, model, edition) and writes the full shop description with specs and the sources it used |
| **Muse Spark 1.3** | Drafts the listing from what the seller said (title, price, sizes, quantity); decides whether a comment is a purchase claim and for which lot and size; matches "the blue mug" to the right lot; writes the post-show recap |
| **SAM 3.1** | Finds the item in the frame so it can be cut out of the shot |
| **Muse Image 1.0** | Turns the cut-out into a clean product photo for the shop and the post |
| **Muse Voice Transcribe 1.0** | Hears the seller through the mic (price, sizes, condition) in short WAV chunks encoded in the browser |
| **Graph API** | Page posts and reading their comments; private replies on Messenger for the pay link; public replies for the waitlist; Connect (user token → never-expiring Page token). Also built, see [What's been tested](#whats-been-tested): Facebook `live_comments` (SSE), Instagram posts, `live_media` and private replies, and the Page `feed` webhook |

## Run it

```
npm install
npm start                       # http://localhost:3000/dashboard/  (mock mode, no keys needed)
npm test                        # 55 tests: claim engine, parsers, webhooks, Woo REST shapes, settings, web research
npm run replay                  # plays a whole scripted show through the real pipeline, prints the outcome
npm run replay -- --realtime    # same show in real time with the dashboard and overlay (demo fallback)
npm run smoke                   # one live call per configured service (Meta models, Graph, Woo)
```

**Two ways to sell, one engine:**
- **Posts (what we run today):** "comment SOLD" drops. Each lot you publish is posted to your Facebook Page with its cleaned-up photo and a caption, and "sold" comments on that post claim it. LiveLot checks the newest post for comments every 5 seconds and older posts every 20 seconds. In our real tests, the private reply went out 7 to 9 seconds after the comment. This works for new shops too, since Meta only lets Pages with 100+ followers go live. Create lots from the camera or from a phone photo plus a line of text.
- **Live:** go live on Facebook and hold items up to the camera; LiveLot reads the live comments.

Both modes use the same Meta models (Spark, SAM 3.1, Muse Image, and Muse Voice when you speak), the same WooCommerce orders and the same private-reply pay links. If the Page has a linked Instagram account, LiveLot posts there and reads its comments as well.

Press **Watch a demo show** on the dashboard to see a full show with pretend buyers, some of them on Instagram: four lots, eleven comments, a contested last unit, a size bundle, an expired hold handed to the waitlist, and payments.

## What's been tested

- **On a real Facebook Page and WooCommerce store:** posts mode. That covers the listing from camera and mic, the Page post, the product in the store, reading a "sold" comment from a personal profile, the order, the private reply with the pay link reaching the buyer's Messenger, and checkout through to Paid. Facebook filed that first message under Message requests → Spam, as the buyer had never messaged the Page.
- **Payments:** our store uses a **Test payment** method that places the order without taking money. It leaves the order `on-hold` in WooCommerce, which LiveLot counts as paid. Card payments through Stripe haven't been run.
- **Built, but not yet run on real accounts:** Facebook Live (our Page is under Meta's 100-follower limit) and Instagram (no account is linked to our deployment).
- **The Page `feed` webhook:** built, but it hasn't delivered a real event to our development-mode app, so our deployment reads comments by polling.

## What happens during a show

| You do | LiveLot does | Meta tech |
|---|---|---|
| Press **N** (or say "next lot") and hold up a jacket | Looks at the frame, names the item, cuts it out of the shot, cleans up the photo | **Muse Spark 1.3** (vision), **SAM 3.1**, **Muse Image 1.0** |
| Say "Levi's trucker, size M, fifteen pounds" | Drafts the listing: title, price, sizes, quantity | **Muse Voice Transcribe**, **Muse Spark 1.3** |
| | Looks the item up on the web: exact model, specs and a full shop description, with its sources. What you said about condition and price always wins | **Muse Spark 1.3** + **web search** |
| Press **Enter** | Creates the WooCommerce product (variable product if it has sizes) | |
| Viewers comment "sold!", "mine", "size 10 please", "I'll take the blue mug" | Reads every comment, decides if it's a claim, which lot and which size | Polling of Page posts (live shows: FB **live_comments** SSE, IG **live_media**), fast rules → **Muse Spark 1.3** → rules as fallback |
| | First valid claim holds the stock, adds a line to that buyer's pending order and sends a **private reply** with a Pay button | Messenger **private replies** (Instagram when linked) |
| | Later claimers get a public reply: "you're #1 on the waitlist" | Graph comment replies |
| | 15 minutes unpaid: the hold is released and the next in line gets the pay link | |
| Buyer pays | Dashboard and on-stream overlay turn green; Woo reduces stock | mu-plugin ping, Woo webhook or poll |

## Pieces

| Path | What it is |
|---|---|
| `src/pipeline/claims.js` | The claim agent: classify → match → reserve or waitlist → order → private reply → expiry → promotion |
| `src/domain/claimMachine.js` | Claim state machine; every transition is checked and recorded |
| `src/pipeline/lots.js` | Lot pipeline: frame → Spark glance → SAM box → crop → Muse Image; speech → listing → publish |
| `src/agents/` | Comment classifier (model chain with a time budget), lot matcher (lot N, descriptive, stream lag), speech parser |
| `src/ai/` | Meta Model API client (Responses API with web search, ASR multipart, image edits), prompts, SAM token parser; an optional Muse Spark Open client for Baseten (off unless `BASETEN_API_KEY` is set; not used in our deployment) |
| `src/settings.js`, `public/settings/` | Settings screen: every connection and rule editable in the browser, write-only secrets, a real **Test connection** per card, changes applied live |
| `src/adapters/meta/connect.js` | Facebook Connect: swaps a Graph API Explorer user token for a never-expiring Page token, checks permissions, finds the linked Instagram account |
| `src/adapters/meta/` | FB live comments (SSE with poll fallback), IG `live_media` poll, private/public replies, signed webhooks |
| `src/adapters/woo/` | WooCommerce REST v3: products + variations, pending orders, line edits, payment poll |
| `src/adapters/mock/` | Stand-ins for both, used by tests, replay and the no-keys demo |
| `public/dashboard/` | Seller control room: a big "do this now" tag, the camera, Meta AI working on the item, the listing, buyers and comments |
| `art/`, `public/art/` | Paper-craft icon art: `art/PROMPTS.txt` (7 image prompts, 6 icons per sheet), `npm run art:sheets` cuts the sheets, removes backgrounds and writes `public/art/*.webp` |
| `public/overlay/` | OBS browser source: the lot price tag, SOLD stamp, live claim ticker (`?portrait` for 1080×1920) |
| `public/capture/` | Studio page: camera frames, live captions, Muse Voice WAV chunks (encoded in the browser), Next-lot button |
| `public/recap/` | Post-show share card for social |
| `woo-plugin/livelot-helper.php` | mu-plugin: guest pay without email re-check, instant "paid" ping |
| `fixtures/demo-show.json` | The scripted show used by replay |

## Why it can't double-sell

- **Arrival order:** comments are analysed in parallel, because model calls take different times, but committed strictly in arrival order. A slow model answer for the first "sold" still wins (tested).
- **Synchronous stock:** taking a unit of stock is synchronous in a single Node process, so there is no await between checking stock and taking it.
- **Per-buyer lock:** each buyer has a lock, so two quick claims from the same person can't create two orders.
- **LiveLot holds the stock:** a WooCommerce `pending` order does not reduce stock, so LiveLot's own count is the source of truth during the show. Woo reduces stock when the order is paid.

## Platform rules it works within

- **Going live needs 100 followers:** Meta requires a Page with at least 100 followers to go live on Facebook. A new shop can still sell with **Sell with posts**. LiveLot reads "sold" comments on a Facebook Page post (or an Instagram post, if an account is linked), and everything after that works the same as in a live show.

- **FB and IG private replies:** one private reply per comment, and on Instagram Live only while the broadcast is on. LiveLot saves each comment's private reply for the pay link. Waitlist notices go out as public comment replies, so a promoted buyer can still be sent their link.
- **Stream lag:** viewers see the stream about 8 s late. A plain "sold" goes to the lot that was on screen 8 s earlier, and comments landing right on a lot change go to the review queue. "lot 3" always wins.
- **Dev mode:** in development mode only people with an app role (Admin, Developer, Tester) are visible. Every demo commenter has to be a Tester.
- **Instagram comment webhooks:** these need App Review. LiveLot polls `live_media` instead; the signed webhook endpoint is built and ready for production.

## Real setup

The easy way: open **Settings** in the dashboard (top right). It has a card each for your WooCommerce shop, your Facebook Page and Instagram, Meta AI, selling rules and LiveLot's web address. Each card has a **Test connection** button, and changes work straight away without a restart. Keys are write-only: the screen only ever shows their last 4 characters. Saved settings go to `SETTINGS_FILE` (default `data/settings.json`) and override the env vars below; shop and Facebook settings can't change while you're selling.

**Judge pass:** Settings → This LiveLot → **Make a judge pass** gives you a sign-in link for judges or guests. It opens the same live dashboard, shop, Page and Meta AI, but can't open Settings or clear your items. Making a new pass, or turning it off, signs the old one out at once.

Or with env vars: copy `.env.example` to `.env`, then:

1. **Meta app** (Business type, dev mode) with Messenger, Instagram and Webhooks. Set `META_APP_SECRET`, `FB_PAGE_ID`, `FB_PAGE_TOKEN` and `IG_USER_ID`. Add your demo buyers as Testers.
   - Page token: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_messaging`, `pages_manage_engagement`, `pages_manage_metadata` (webhook subscription) and `pages_manage_posts` (post mode).
   - Instagram: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` and `instagram_content_publish` (post mode).
2. **WooCommerce** on HTTPS: REST key (read/write) in `WOO_*`, Stripe in test mode, `woo-plugin/livelot-helper.php` in `wp-content/mu-plugins/`, plus `LIVELOT_URL` and `LIVELOT_SECRET` in `wp-config.php`.
3. **Model keys:** `MODEL_API_KEY` (Spark, SAM, Voice, Image). Optionally `BASETEN_API_KEY` for Spark Open as the first comment classifier (we didn't use it).
4. **Tunnel:** `cloudflared tunnel --url http://localhost:3000`, then put the URL in `PUBLIC_BASE_URL`. The Meta webhook goes to `/webhooks/meta`.
5. **Stream:**
   - OBS owns the camera. Start **Virtual Camera** and add `http://localhost:3000/overlay/` as a 1920×1080 browser source.
   - Open `/capture/` in Chrome and pick "OBS Virtual Camera" plus your mic. Web Speech only runs in Chrome, not inside OBS.
   - Stream to your Page with the Live Producer stream key.
6. Run `npm run smoke` and fix anything marked ✗. Then `npm start`, press **Go live** and stream.

## Hosting

LiveLot's server has to be **one always-on process**:
- **Stock:** the stock counter and the order in which comments are committed live in memory. That is what stops double-selling.
- **Background work:** it checks your posts for comments, holds the Facebook `live_comments` stream open during a live show, polls Instagram when an account is linked, and sweeps expired holds every second.

Plain serverless (Vercel Functions included) scales stateless instances on demand, and that breaks both. Run it as a single process that stays up and keep it to **one replica**.

**Google Cloud Run (what we use):** `scripts/deploy-cloudrun.sh` deploys from source with min = max = 1 instance, CPU always on, and a 60-minute request timeout (the dashboard's live feed reconnects after that). Defaults come from `deploy/cloudrun.env.yaml` (gitignored; template in `deploy/cloudrun.env.example.yaml`). Whatever is saved in the Settings screen goes to a private Cloud Storage bucket mounted at `/settings`, so it survives deploys and restarts (create the bucket once; the command is in the script header). The first deploy is private; making it public is one deliberate command, shown in the script header. Railway, Fly.io or a small VPS work the same way.

**Our live setup:**

| What | Where | How |
|---|---|---|
| LiveLot (dashboard, overlay, studio, pay links, webhooks) | https://livelot.stream | Cloud Run `livelot` (europe-west2), behind the Cloudflare Worker in `deploy/cloudflare/`, because Cloud Run custom domains aren't offered in that region |
| WooCommerce store | https://shop.livelot.stream | e2-small VM `livelot-shop`, Docker Compose (WordPress, MariaDB, Caddy auto-HTTPS), see `deploy/shop/` |

- **Store setup:** `deploy/shop/setup.sh` runs on the VM and does WooCommerce, guest checkout, permalinks, the mu-plugin and the REST key. `switch-domain.sh` moves the store to another hostname.
- **Secrets:** they live only in the gitignored `deploy/cloudrun.env.yaml`, `deploy/shop/.env` and `deploy/shop/.woo-keys`.
- **DNS:** the `shop` record has the Cloudflare proxy off, so Caddy can get its own certificate.

- Set `ADMIN_TOKEN`, `PUBLIC_BASE_URL` (the host's https URL) and the keys from `.env.example`. The host provides `PORT`.
- Start command: `npm start`. Product photos and the state snapshot go to `data/`; mount a volume there if you want them to survive restarts.
- In OBS, use `https://<host>/overlay/?token=<ADMIN_TOKEN>`. Open the studio at `https://<host>/capture/` in Chrome; the camera needs https.

Node 22 or later. Dependencies: `express` (plus optional `sharp` for cropping). Everything else uses Node's built-in `fetch`.

## Licence

MIT, see [LICENSE](LICENSE).
