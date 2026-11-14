// ═══════════════════════════════════════════════════════════════
// First Draft Coffee — Unified Cloudflare Worker (v2)
// Handles: CV Review, Brew Compass, Job Listings, Shift Cover,
//          Stripe Checkout + Webhook, Flag/Report alerts,
//          Application digest mode, renewal reminders
// (redeploy trigger — forces this commit to promote to 100% traffic
// via the normal GitHub deploy path, rather than a dashboard-only
// secret edit that can get stuck at 0% traffic)
// ═══════════════════════════════════════════════════════════════

const PRICE_IDS = {
  job_standard:       'price_1TusgiJExrSWtqFLz37CJZd2',
  job_featured:       'price_1Tush8JExrSWtqFLF1xMwK7J',
  job_retainer:       'price_1TvNkVJExrSWtqFL22x9WWtN',
  shift_need:         'price_1TvbIvJExrSWtqFLmhrDFPKU',
  shift_need_urgent:  'price_1Tusg8JExrSWtqFLBMrLWFbD',
  cv_full:            'price_1TvbGRJExrSWtqFLSdBRAtZI',
  contact_reveal:     'price_1U66JFJExrSWtqFLSuhdfQ06', // €10 one-off — reveal contact for one "available" listing
};

const LISTING_DAYS = { job_standard: 14, job_featured: 30, shift_need: 7, shift_need_urgent: 7 };

// FREE LAUNCH SWITCH — set FREE_POSTING = "true" in wrangler.toml [vars]
// to make Standard job posts, Standard shift-cover posts and contact
// unlocks free. Featured / Urgent stay paid for anyone who wants to
// stand out. Set it to "false" (and restore the prices in job-board.html
// and shift-cover.html) to switch charging back on.
function isFreeLaunch(env) { return String(env.FREE_POSTING || '').toLowerCase() === 'true'; }
const FREE_TIERS = { job: 'standard', shift_need: 'need' };

const IRISH_HOSPITALITY_KNOWLEDGE = `
IRISH HOSPITALITY & COFFEE JOB MARKET KNOWLEDGE (2026) — ground your review in this, not generic advice:

PAY BANDS 2026 (entry / experienced / senior):
- Barista: €14.50-15.50 / €15.50-17 / €17-19 per hr
- Head Barista: — / €17-19 / €19-22 per hr
- Waiter/Server: €14.50-15.50 / €15.50-18 / €18-20 per hr
- Bartender: €14.50-16 / €16-18 / €18-20 per hr
- Kitchen Porter: €14.50-15.50 / €15.50-17 / €17+ per hr
- Hotel Receptionist: €15-16 / €16-18 / €18-20 per hr
- Café Manager: €38-45k / €45-55k / €55-65k+
- Head Chef: €45-55k / €55-70k / €70-90k+
Dublin typically adds €1-2/hr for hourly staff and €5-10k/yr for managers on top of the above. Galway and Cork are closing the gap with Dublin; smaller towns run below these figures. National minimum wage is €14.50/hr (from 1 Jan 2026).

CERTIFICATIONS — what actually matters to employers, don't overweight the rest:
- HACCP: essential, especially for chefs, kitchen staff, café managers, supervisors. Worth flagging if missing.
- RSA (Responsible Service of Alcohol): essential wherever alcohol is served — hotels, restaurants, bars, wine cafés.
- Manual Handling: expected, not impressive, but absence can delay onboarding.
- First Aid: a genuine plus for supervisors/managers.
- SCA Barista Skills: Foundation is good, Intermediate is valuable, Professional shows real commitment.
- Sensory/cupping certs: valuable for specialty coffee roles, especially QC/roasting.
- Green coffee certs: mostly relevant only to roasteries. Roasting certs: a big plus but niche.
- Latte art certificates, generic "coffee school" attendance, or unrecognised online certs rarely move the needle.

WHAT MAKES A HOSPITALITY/COFFEE CV ACTUALLY STAND OUT:
- Named equipment/machine experience (e.g. La Marzocco Linea PB/KB90, Victoria Arduino Black Eagle, Mythos, Mahlkönig EK43/E65S, Mazzer Robur, PuqPress) signals real skill level.
- Recognisable, respected venues (established specialty cafés, well-regarded hotels, Michelin restaurants) add credibility — a year somewhere excellent often outweighs three years somewhere unknown.
- Multi-site experience (area manager, operations, training, regional) signals systems thinking — a big plus for senior roles.
- Quantified achievements ("managed 12 staff," "€25k weekly sales," "reduced waste by 15%," "opened 3 new cafés") beat duty lists every time.
- Clear promotion history (Barista → Senior Barista → Head Barista → Manager) shows people trusted them.

COMMON CV MISTAKES WORTH FLAGGING:
- "Passionate about coffee/hospitality" — meaningless filler on almost every CV, should be cut.
- Missing employment dates — an immediate red flag to employers.
- Large unexplained employment gaps — not necessarily bad, but should be briefly addressed.
- CVs over 2 pages (3 max for senior management) — too long.
- Walls of text instead of bullet points — hard to skim.
- Listing duties ("made coffee, served customers, cleaned café") instead of impact/achievements — the single biggest weakness to flag.
- Misspelled venue names (getting well-known places or chains wrong) — very noticeable, a real credibility hit.
- Generic objective statements ("seeking a challenging position...") — should be cut entirely.
- Missing contact details — more common than you'd think, always worth checking.

HIRING SEASONALITY (useful for advice on timing an application):
Jan-Feb quiet (post-Christmas, replacing staff only). March hiring begins, April-May busy. June-August peak (tourism, events, students). September another spike as students leave and businesses stabilise. October steady. November is Christmas recruitment season. December is almost entirely emergency cover, very little permanent hiring. Coffee-specific hiring often follows café openings, new wholesale contracts, roasting expansion, and summer tourism.
`;

export default {
  async fetch(request, env, ctx) {
    const ALLOWED_ORIGIN = '*';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET,POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    try {
      if (path.startsWith('/scan/') || path.startsWith('/invite/')) {
        const scanResponse = await handleScanRoute(path, request, url, env, ctx);
        if (scanResponse) return scanResponse;
      }

      if ((path === '/cv' || path === '/' || path === '') && request.method === 'POST') {
        const { cv, role } = await request.json();
        if (!cv || cv.length < 100) return jsonResponse({ error: 'CV too short' }, 400, ALLOWED_ORIGIN);
        if (cv.length > 8000) return jsonResponse({ error: 'CV too long' }, 400, ALLOWED_ORIGIN);

        const prompt = `You are an expert recruiter specialising in the Irish coffee and hospitality industry, working nationwide (not just Dublin).
${IRISH_HOSPITALITY_KNOWLEDGE}
Review this CV for someone applying for a ${role || 'barista'} role. Score it against this exact 100-point matrix — use the full range within each category, don't default to the middle. Never let the cause of a gap, non-native English phrasing, age, gender, disability, or immigration status affect any score:
- reliability (0-25): tenure length per role and job-hopping pattern — this is the single biggest factor; score strictly on frequency/length of stints, never on any assumed cause of a gap or a short stint
- experience (0-20): relevance and quality of roles/venues to the target role
- achievements (0-20): quantified impact, competitions, training others, promotions earned, measurable results — not just duties
- progression (0-10): promotions, increasing responsibility over time
- technicalSkills (0-10): named equipment/machines, POS/booking systems, multi-site systems experience
- presentation (0-5): length, structure, clarity, spelling (especially venue names), no generic filler like "passionate" — never penalise non-native English phrasing here
- certifications (0-5): HACCP, RSA, SCA levels, First Aid etc. — per the guidance above on what actually matters
- roleFit (0-5): how well the CV's experience and stated goals fit the target role, including realistic fits for total beginners
Be specific, practical, and direct — ground feedback in the real pay bands, certifications, and standout factors above rather than generic advice. Always stay encouraging in tone, even for a weak CV — focus on concrete next steps rather than just listing deficits.
CV: ${cv}
Respond ONLY with a JSON object (no markdown, no backticks, no overall score — that's calculated separately):
{"scoreBreakdown":{"reliability":<0-25>,"experience":<0-20>,"achievements":<0-20>,"progression":<0-10>,"technicalSkills":<0-10>,"presentation":<0-5>,"certifications":<0-5>,"roleFit":<0-5>},"bestFitRole":"<the specific role(s) this candidate is best suited for right now>","strengths":["...","...","..."],"improvements":["...","...","..."],"missingElements":["...","..."],"verdict":"<2-3 sentences>"}`;

        const data = await callClaude(prompt, env);
        const text = data.content.map(i => i.text || '').join('');
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

        const b = parsed.scoreBreakdown || {};
        const score = Math.round((b.reliability||0) + (b.experience||0) + (b.achievements||0) + (b.progression||0) + (b.technicalSkills||0) + (b.presentation||0) + (b.certifications||0) + (b.roleFit||0));
        const scoreLabel = score >= 85 ? 'Outstanding candidate' : score >= 70 ? 'Strong candidate' : score >= 50 ? 'Solid, needs work' : 'Needs significant work';
        parsed.score = score;
        parsed.scoreLabel = scoreLabel;

        return jsonResponse(parsed, 200, ALLOWED_ORIGIN);
      }

      if (path === '/cv/full/start' && request.method === 'POST') {
        const { cv, role, email } = await request.json();
        if (!cv || cv.length < 100) return jsonResponse({ error: 'CV too short' }, 400, ALLOWED_ORIGIN);
        if (cv.length > 8000) return jsonResponse({ error: 'CV too long' }, 400, ALLOWED_ORIGIN);
        const priceId = PRICE_IDS.cv_full;
        if (!priceId) return jsonResponse({ error: 'Full review not configured yet' }, 400, ALLOWED_ORIGIN);

        const id = crypto.randomUUID();
        await env.FDC_STORE.put(`cvreview:${id}`, JSON.stringify({ cv, role, status: 'pending', createdAt: Date.now() }), { expirationTtl: 60 * 60 * 2 });

        const params = new URLSearchParams();
        params.append('mode', 'payment');
        params.append('allow_promotion_codes', 'true');
        params.append('line_items[0][price]', priceId);
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', `${env.SITE_URL}/cv-review.html?reviewId=${id}&success=1`);
        params.append('cancel_url', `${env.SITE_URL}/cv-review.html?cancelled=1`);
        params.append('metadata[reviewId]', id);
        if (email) params.append('customer_email', email);

        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        if (!res.ok) { const errText = await res.text(); return jsonResponse({ error: 'Stripe: ' + errText.slice(0,200) }, 500, ALLOWED_ORIGIN); }
        const session = await res.json();
        return jsonResponse({ checkoutUrl: session.url }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/cv/full/result' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`cvreview:${id}`);
        if (!raw) return jsonResponse({ error: 'Not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);

        if (record.status === 'pending') return jsonResponse({ status: 'pending' }, 200, ALLOWED_ORIGIN);

        if (record.status === 'paid') {
          try {
            const result = await generateFullReviewResult(record, env);
            record.status = 'done';
            record.result = result;
            await env.FDC_STORE.put(`cvreview:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
            return jsonResponse({ status: 'done', result }, 200, ALLOWED_ORIGIN);
          } catch (e) {
            console.error('Full review generation failed:', String(e));
            record.attempts = (record.attempts || 0) + 1;
            record.lastError = String(e);
            await env.FDC_STORE.put(`cvreview:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
            if (record.attempts >= 3) {
              return jsonResponse({ status: 'error', error: 'We hit a problem generating your review. Please contact us and we\'ll sort it out — your payment is confirmed either way.' }, 200, ALLOWED_ORIGIN);
            }
            return jsonResponse({ status: 'paid' }, 200, ALLOWED_ORIGIN);
          }
        }

        return jsonResponse({ status: 'done', result: record.result }, 200, ALLOWED_ORIGIN);
      }
      if (path === '/brew' && request.method === 'POST') {
        const { method, issue } = await request.json();
        if (!issue || issue.trim().length < 10) return jsonResponse({ error: 'Please describe the issue' }, 400, ALLOWED_ORIGIN);

        const prompt = `You are a specialist coffee trainer with 30 years of experience in specialty coffee.
Give precise, practical brew diagnostics. Be direct and brief.
Format: numbered list of 3-5 specific actionable fixes, most likely cause first.
Keep each fix to 1-2 sentences max.
End with one sentence on what to taste for to confirm the fix worked.
Brew method: ${method}. Problem: ${issue}`;

        const data = await callClaude(prompt, env);
        const result = data.content.map(i => i.text || '').join('');
        return jsonResponse({ result }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/listings/create' && request.method === 'POST') {
        const body = await request.json();
        const { kind, tier, data } = body;
        if (!data || !kind) return jsonResponse({ error: 'Missing kind or data' }, 400, ALLOWED_ORIGIN);
        if (kind === 'job' && (!data.salary || !String(data.salary).trim())) {
          return jsonResponse({ error: 'A salary range is required for job listings' }, 400, ALLOWED_ORIGIN);
        }
        // Optional: the employer's own application page. Only plain web
        // links are accepted, so nothing else can be smuggled in as a link.
        if (data.applyUrl) {
          const link = String(data.applyUrl).trim();
          if (!/^https?:\/\/[^\s"'<>]+$/i.test(link) || link.length > 500) {
            return jsonResponse({ error: 'The apply link should be a normal web address starting with https://' }, 400, ALLOWED_ORIGIN);
          }
          data.applyUrl = link;
        }

        const id = crypto.randomUUID();
        const record = {
          id, kind, tier: tier || null,
          data, status: 'pending_payment',
          createdAt: Date.now(),
          flagged: false,
        };

        if (kind === 'shift_available') {
          record.status = 'published';
          const ttl = 14 * 24 * 60 * 60;
          record.expiresAt = Date.now() + ttl * 1000;
          await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
          ctx.waitUntil(postToSocial(record, env));
          ctx.waitUntil(notifyGroupPost(record, env));
          ctx.waitUntil(sendListingConfirmation(record, env));
          return jsonResponse({ published: true, id }, 200, ALLOWED_ORIGIN);
        }

        // Free launch: Standard posts skip checkout and go live straight
        // away, with the same social post, Group note and confirmation
        // email a paid post gets.
        if (isFreeLaunch(env) && FREE_TIERS[kind] && FREE_TIERS[kind] === (tier || FREE_TIERS[kind])) {
          record.status = 'published';
          record.tier = FREE_TIERS[kind];
          record.freeLaunch = true;
          const days = LISTING_DAYS[kind === 'job' ? `job_${record.tier}` : `shift_${record.tier}`] || 14;
          const ttl = days * 24 * 60 * 60;
          record.expiresAt = Date.now() + ttl * 1000;
          await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
          ctx.waitUntil(postToSocial(record, env));
          ctx.waitUntil(notifyGroupPost(record, env));
          ctx.waitUntil(sendListingConfirmation(record, env));
          return jsonResponse({ published: true, free: true, id }, 200, ALLOWED_ORIGIN);
        }

        if (kind === 'job' && data.email) {
          const subscribed = await hasActiveSubscription(data.email, env);
          if (subscribed) {
            record.status = 'published';
            record.tier = 'subscriber';
            const ttl = 30 * 24 * 60 * 60;
            record.expiresAt = Date.now() + ttl * 1000;
            await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
            ctx.waitUntil(postToSocial(record, env));
            ctx.waitUntil(notifyGroupPost(record, env));
            ctx.waitUntil(sendListingConfirmation(record, env));
            return jsonResponse({ published: true, id }, 200, ALLOWED_ORIGIN);
          }
        }

        const priceKey = kind === 'job' ? `job_${tier}` : `shift_${tier}`;
        const priceId = PRICE_IDS[priceKey];
        if (!priceId) return jsonResponse({ error: 'Unknown tier' }, 400, ALLOWED_ORIGIN);

        await env.FDC_STORE.put(`pending:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });

        const session = await createStripeCheckoutSession({
          priceId,
          listingId: id,
          email: data.email,
          successUrl: `${env.SITE_URL}/posted?success=1&id=${id}`,
          cancelUrl: `${env.SITE_URL}/posted?cancelled=1`,
        }, env);

        return jsonResponse({ checkoutUrl: session.url, id }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/subscribe/create' && request.method === 'POST') {
        const { email } = await request.json();
        if (!email) return jsonResponse({ error: 'Email is required' }, 400, ALLOWED_ORIGIN);
        const priceId = PRICE_IDS.job_retainer;
        if (!priceId) return jsonResponse({ error: 'Subscription not configured yet' }, 400, ALLOWED_ORIGIN);

        const params = new URLSearchParams();
        params.append('mode', 'subscription');
        params.append('allow_promotion_codes', 'true');
        params.append('customer_email', email);
        params.append('line_items[0][price]', priceId);
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', `${env.SITE_URL}/posted?success=1&subscribed=1`);
        params.append('cancel_url', `${env.SITE_URL}/posted?cancelled=1`);

        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        if (!res.ok) { const errText = await res.text(); return jsonResponse({ error: 'Stripe: ' + errText.slice(0,200) }, 500, ALLOWED_ORIGIN); }
        const session = await res.json();
        return jsonResponse({ checkoutUrl: session.url }, 200, ALLOWED_ORIGIN);
      }

      // Pay-to-reveal contact details for one specific "available" staff
      // post — the simple version, no bundled pass/expiry/posting-bypass.
      // One-off Stripe Checkout keyed to a specific listingId + the
      // buyer's own email via metadata; the webhook below does the actual
      // reveal once payment completes, by emailing the real contact
      // details straight to the buyer. No state to track before payment.
      if (path === '/listings/reveal-contact/create' && request.method === 'POST') {
        const { listingId, buyerEmail } = await request.json();
        if (!listingId || !buyerEmail) return jsonResponse({ error: 'Missing listingId or buyerEmail' }, 400, ALLOWED_ORIGIN);
        const normalizedEmail = buyerEmail.trim().toLowerCase();

        const listingRaw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!listingRaw) return jsonResponse({ error: 'That listing was not found or has expired' }, 404, ALLOWED_ORIGIN);
        const listing = JSON.parse(listingRaw);
        if (listing.kind !== 'shift_available') return jsonResponse({ error: 'That listing is not an availability post' }, 400, ALLOWED_ORIGIN);

        // Free launch: email the contact details straight away, no checkout.
        if (isFreeLaunch(env)) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return jsonResponse({ error: 'Please enter a valid email address' }, 400, ALLOWED_ORIGIN);
          ctx.waitUntil(sendEmailTo(env, normalizedEmail, 'Contact details for an available staff member', contactRevealText(listing.data || {})));
          return jsonResponse({ revealed: true }, 200, ALLOWED_ORIGIN);
        }

        const priceId = PRICE_IDS.contact_reveal;
        if (!priceId) return jsonResponse({ error: 'Contact reveal not configured yet' }, 400, ALLOWED_ORIGIN);

        const params = new URLSearchParams();
        params.append('mode', 'payment');
        params.append('allow_promotion_codes', 'true');
        params.append('customer_email', normalizedEmail);
        params.append('line_items[0][price]', priceId);
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', `${env.SITE_URL}/shift-cover.html?revealSuccess=1`);
        params.append('cancel_url', `${env.SITE_URL}/shift-cover.html?revealCancelled=1`);
        params.append('metadata[revealListingId]', listingId);
        params.append('metadata[revealBuyerEmail]', normalizedEmail);

        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        if (!res.ok) { const errText = await res.text(); return jsonResponse({ error: 'Stripe: ' + errText.slice(0,200) }, 500, ALLOWED_ORIGIN); }
        const session = await res.json();
        return jsonResponse({ checkoutUrl: session.url }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/webhook/stripe' && request.method === 'POST') {
        const sig = request.headers.get('stripe-signature');
        const rawBody = await request.text();
        const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
        if (!valid) return new Response('Invalid signature', { status: 400 });

        const event = JSON.parse(rawBody);
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const listingId = session.metadata?.listingId;
          const reviewId = session.metadata?.reviewId;
          const revealListingId = session.metadata?.revealListingId;
          const revealBuyerEmail = session.metadata?.revealBuyerEmail;
          if (listingId) {
            const pendingRaw = await env.FDC_STORE.get(`pending:${listingId}`);
            if (pendingRaw) {
              const record = JSON.parse(pendingRaw);
              record.status = 'published';
              record.paidAt = Date.now();
              const days = LISTING_DAYS[record.kind === 'job' ? `job_${record.tier}` : `shift_${record.tier}`] || 14;
              const ttl = days * 24 * 60 * 60;
              record.expiresAt = Date.now() + ttl * 1000;
              await env.FDC_STORE.put(`listing:${listingId}`, JSON.stringify(record), { expirationTtl: ttl });
              await env.FDC_STORE.delete(`pending:${listingId}`);
              if (record.kind === 'job' || record.kind === 'shift_need') {
                ctx.waitUntil(postToSocial(record, env));
                ctx.waitUntil(notifyGroupPost(record, env));
                ctx.waitUntil(sendListingConfirmation(record, env));
              }
            }
          } else if (reviewId) {
            const raw = await env.FDC_STORE.get(`cvreview:${reviewId}`);
            if (raw) {
              const record = JSON.parse(raw);
              record.status = 'paid';
              await env.FDC_STORE.put(`cvreview:${reviewId}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
              ctx.waitUntil((async () => {
                try {
                  const result = await generateFullReviewResult(record, env);
                  record.status = 'done';
                  record.result = result;
                  await env.FDC_STORE.put(`cvreview:${reviewId}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
                } catch (e) {
                  console.error('Background full review generation failed:', String(e));
                  record.lastError = String(e);
                  await env.FDC_STORE.put(`cvreview:${reviewId}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
                }
              })());
            }
          } else if (revealListingId && revealBuyerEmail) {
            const targetRaw = await env.FDC_STORE.get(`listing:${revealListingId}`);
            if (targetRaw) {
              const target = JSON.parse(targetRaw);
              ctx.waitUntil(sendEmailTo(env, revealBuyerEmail, 'Contact details unlocked', contactRevealText(target.data || {})));
            } else {
              ctx.waitUntil(sendEmailTo(env, revealBuyerEmail, 'Contact details unlocked',
                'Sorry — that listing has since expired or been removed, so we can\'t send its contact details. If you were charged, reply to this email and we\'ll sort a refund.'));
            }
                   } else if (session.mode === 'subscription') {
            // IMPORTANT: this webhook endpoint receives subscription events
            // for the whole Stripe account, not just Dublin Coffee Jobs —
            // other First Draft Coffee products (e.g. Coffee Deck Pro) also
            // create subscription-mode checkout sessions with no DCJ
            // metadata, and used to fall through to here by exclusion,
            // wrongly sending the DCJ confirmation email to their
            // subscribers. Always confirm the actual price before emailing.
            const subscriberEmail = session.customer_email || session.customer_details?.email;
            let isEmployerSub = false;
            try {
              const liRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`, {
                headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
              if (liRes.ok) {
                const liData = await liRes.json();
                isEmployerSub = (liData.data || []).some(li => li.price?.id === PRICE_IDS.job_retainer);
              } else {
                console.error('Subscription webhook: failed to fetch line items, status', liRes.status);
              }
            } catch (e) {
              console.error('Subscription webhook: error fetching line items:', String(e));
            }
            console.log('Subscription webhook — subscriberEmail:', subscriberEmail, 'isEmployerSub:', isEmployerSub);
            if (isEmployerSub && subscriberEmail) {
              ctx.waitUntil(sendEmailTo(env, subscriberEmail, 'Your Dublin Coffee Jobs subscription is active',
                `Thanks for subscribing to unlimited job posts on Dublin Coffee Jobs.\n\nYour subscription is now active. From here:\n\n- Post as many jobs as you like at ${env.SITE_URL}/job-board.html — use this same email address (${subscriberEmail}) each time and it'll publish free automatically, no checkout needed.\n- Add a logo URL when posting and it'll show on your listings.\n- Manage or cancel any time from the receipt/invoice email Stripe sends separately, or by contacting us directly.\n\nQuestions — just reply to this email.`));
            } else if (!isEmployerSub) {
              console.log('Subscription webhook: not a DCJ Employer Subscription (different product on the same Stripe account) — no email sent.');
            } else {
              console.error('Subscription webhook fired but no subscriberEmail found on session — email not sent.');
            }
          }
        }
        return new Response('ok', { status: 200 });
      }

      // Public board listing. For kind=shift_available, this is also
      // where the monetisation leak used to live: email and whatsapp
      // were sent to every visitor for free, letting employers contact
      // available staff directly without ever paying for anything —
      // hiding the contact buttons in the UI alone wouldn't have been
      // enough, since the raw data was still sitting right there in this
      // response for anyone to read. Those two fields are now always
      // stripped for this kind; real contact details only ever leave the
      // server via email, after a successful reveal-contact payment (see
      // /listings/reveal-contact/create and the webhook below).
      if (path === '/listings' && request.method === 'GET') {
        const kind = url.searchParams.get('kind');
        const list = await env.FDC_STORE.list({ prefix: 'listing:' });
        const items = [];
        for (const key of list.keys) {
          const raw = await env.FDC_STORE.get(key.name);
          if (!raw) continue;
          const record = JSON.parse(raw);
          if (record.flagged) continue;
          if (kind && record.kind !== kind) continue;
          const viewsRaw = await env.FDC_STORE.get(`views:${record.id}`);
          record.views = viewsRaw ? parseInt(viewsRaw, 10) : 0;
          if (record.kind === 'shift_available') {
            record.data = { ...record.data, email: undefined, whatsapp: undefined };
            record.contactLocked = true;
          }
          items.push(record);
        }
        items.sort((a, b) => b.createdAt - a.createdAt);
        return jsonResponse({ items }, 200, ALLOWED_ORIGIN);
      }

      // Public lookup by ID only, no email check — used to pre-fill a
      // FRESH post from an expiring listing's renewal-reminder email link.
      // Deliberately unauthenticated like the existing public listing
      // detail view: it only feeds data into a new, unpublished post draft
      // in the visitor's own browser, it doesn't edit or expose anything
      // about the original listing that isn't already visible on the
      // public board while that listing is live.
      if (path === '/listings/lookup' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        // Same rule as the public board: an "available" post's email and
        // WhatsApp are only ever released through the paid reveal. Without
        // this, anyone could read them here for free using the listing ID.
        if (record.kind === 'shift_available') {
          record.data = { ...record.data, email: undefined, whatsapp: undefined };
          record.contactLocked = true;
        }
        return jsonResponse({ record }, 200, ALLOWED_ORIGIN);
      }

      // Counts clicks on "Apply on their site" (for the weekly numbers).
      if (path === '/stats/click' && request.method === 'POST') {
        ctx.waitUntil(bumpStat(env, 'applyClicks'));
        return jsonResponse({ ok: true }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/listings/view' && request.method === 'POST') {
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const current = await env.FDC_STORE.get(`views:${id}`);
        const next = (current ? parseInt(current, 10) : 0) + 1;
        await env.FDC_STORE.put(`views:${id}`, String(next), { expirationTtl: 60 * 60 * 24 * 45 });
        return jsonResponse({ views: next }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/employers/signup' && request.method === 'POST') {
        return await handleEmployerSignup(request, env, ALLOWED_ORIGIN);
      }

      if (path === '/alerts/create' && request.method === 'POST') {
        const { email, kind, role, area, minRate } = await request.json();
        if (!email || !kind) return jsonResponse({ error: 'Email and kind are required' }, 400, ALLOWED_ORIGIN);
        const id = crypto.randomUUID();
        const alert = { id, email, kind, role: role || '', area: area || '', minRate: minRate || 0, createdAt: Date.now(), lastChecked: Date.now() };
        await env.FDC_STORE.put(`alert:${id}`, JSON.stringify(alert), { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResponse({ created: true }, 200, ALLOWED_ORIGIN);
      }

      // Reporting a listing. It used to hide the listing instantly on a
      // single report from anyone, which meant one person could knock every
      // paid listing off the board. Now each report is logged and emailed to
      // the admin (with one-click Hide / Delete links), and a listing is only
      // hidden automatically once 3 different people have reported it.
      if (path === '/flag' && request.method === 'POST') {
        const { listingId, reason } = await request.json();
        if (!listingId) return jsonResponse({ error: 'Missing listingId' }, 400, ALLOWED_ORIGIN);

        const raw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!raw) return jsonResponse({ error: 'Listing not found' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);

        const reporter = await hashText(request.headers.get('CF-Connecting-IP') || 'unknown');
        record.flagReports = Array.isArray(record.flagReports) ? record.flagReports : [];
        if (record.flagReports.some(r => r.by === reporter)) {
          return jsonResponse({ flagged: true }, 200, ALLOWED_ORIGIN); // same person reporting again — ignore quietly
        }
        record.flagReports.push({ by: reporter, reason: String(reason || 'No reason given').slice(0, 300), at: Date.now() });
        const AUTO_HIDE_AT = 3;
        const nowHidden = !record.flagged && record.flagReports.length >= AUTO_HIDE_AT;
        if (nowHidden) record.flagged = true;
        record.flagReason = record.flagReports[record.flagReports.length - 1].reason;
        await putListing(env, record);

        const origin = new URL(request.url).origin;
        const hideUrl = `${origin}/admin/hide?id=${listingId}&token=${env.ADMIN_TOKEN}`;
        const deleteUrl = `${origin}/admin/delete?id=${listingId}&token=${env.ADMIN_TOKEN}`;
        const restoreUrl = `${origin}/admin/restore?id=${listingId}&token=${env.ADMIN_TOKEN}`;
        const status = record.flagged
          ? `It is now HIDDEN from the board${nowHidden ? ` (auto-hidden after ${AUTO_HIDE_AT} separate reports)` : ''}.`
          : `It is still VISIBLE on the board (${record.flagReports.length} of ${AUTO_HIDE_AT} reports needed to auto-hide).`;

        await sendAlertEmail(env, {
          subject: `[Dublin Coffee Jobs] Listing reported (${record.flagReports.length}) — ${record.data?.title || record.data?.role || 'untitled'}`,
          text: `A listing was reported. ${status}\n\nLatest reason: ${record.flagReason}\n\nAll reasons so far:\n${record.flagReports.map(r => '- ' + r.reason).join('\n')}\n\nListing summary: ${JSON.stringify(record.data, null, 2)}\n\nHide it now: ${hideUrl}\nPermanently delete: ${deleteUrl}\nRestore / clear reports (false alarm): ${restoreUrl}`,
        });

        return jsonResponse({ flagged: true }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/admin/hide' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return new Response('Listing not found or already expired.', { status: 404, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
        const record = JSON.parse(raw);
        record.flagged = true;
        await putListing(env, record);
        return new Response('Listing hidden from the board. You can close this tab.', { status: 200, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
      }

      if (path === '/admin/delete' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
        await env.FDC_STORE.delete(`listing:${id}`);
        return new Response('Listing deleted permanently. You can close this tab.', { status: 200, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
      }
      if (path === '/admin/restore' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (raw) {
          const record = JSON.parse(raw);
          record.flagged = false;
          record.flagReports = [];
          await putListing(env, record);
        }
        return new Response('Listing restored to the board. You can close this tab.', { status: 200, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } });
      }

      if (path === '/admin/listing' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        return jsonResponse({ record: JSON.parse(raw) }, 200, ALLOWED_ORIGIN);
      }
      if (path === '/admin/listing' && request.method === 'POST') {
        const { id, token, data, pinned, extendDays } = await request.json();
        if (token !== env.ADMIN_TOKEN) return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
        if (!id || !data) return jsonResponse({ error: 'Missing id or data' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        record.data = { ...record.data, ...data };
        record.editedAt = Date.now();
        if (typeof pinned === 'boolean') record.pinned = pinned;
        if (typeof extendDays === 'number' && extendDays > 0) {
          const base = Math.max(record.expiresAt || 0, Date.now());
          record.expiresAt = base + extendDays * 24 * 60 * 60 * 1000;
          // A manual extend is a fresh lease on life for this listing —
          // clear the renewal-reminder flag so it can remind again ahead
          // of the new (later) expiry instead of staying silently marked
          // as "already reminded" from before the extension.
          record.renewReminderSent = false;
        }
        const remainingTtl = record.expiresAt ? Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000)) : 60 * 60 * 24 * 14;
        await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: remainingTtl });
        return jsonResponse({ saved: true, expiresAt: record.expiresAt }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/admin/listings' && request.method === 'GET') {
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
        const list = await env.FDC_STORE.list({ prefix: 'listing:' });
        const items = [];
        for (const key of list.keys) {
          const raw = await env.FDC_STORE.get(key.name);
          if (raw) items.push(JSON.parse(raw));
        }
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return jsonResponse({ items }, 200, ALLOWED_ORIGIN);
      }

      // ── Admin manual social post — a genuine standalone tool, not tied
      // to any listing. Reuses the exact same postImageAndCaptionToSocial()
      // Graph API wiring the automatic listing posts use, so anything
      // that's already proven to work there works here too. Custom
      // caption text, optional custom image (upload via /upload/image
      // first, same as the logo/photo dropzones) — falls back to the
      // shared 66-photo rotation if no image is given, since Instagram
      // requires an image for a feed post either way. Returns per-platform
      // success/failure so the admin page can show real feedback. ──
      if (path === '/admin/post-social' && request.method === 'POST') {
        const { token, caption, imageUrl } = await request.json();
        if (token !== env.ADMIN_TOKEN) return jsonResponse({ error: 'Forbidden' }, 403, ALLOWED_ORIGIN);
        if (!caption || !caption.trim()) return jsonResponse({ error: 'Caption text is required' }, 400, ALLOWED_ORIGIN);
        if (caption.length > 2200) return jsonResponse({ error: 'Caption is too long for Instagram (max 2200 characters)' }, 400, ALLOWED_ORIGIN);

        const finalImageUrl = (imageUrl && imageUrl.trim()) ? imageUrl.trim() : await nextRotationImage(env);
        const result = await postImageAndCaptionToSocial({ imageUrl: finalImageUrl, caption: caption.trim() }, env);
        return jsonResponse({ posted: true, imageUrl: finalImageUrl, result }, 200, ALLOWED_ORIGIN);
      }

      // ── APPLY — sends the application by email server-side, so a
      // candidate's CV (pasted once, remembered in their browser) doesn't
      // need re-attaching for every job. Also stores the application (with
      // a job-specific match score, unless the employer opted out) so the
      // employer can view a ranked shortlist later at /applicants.
      //
      // If the listing has digestMode on, the instant employer email is
      // skipped here — the daily digest job (see runDigestJob below) picks
      // it up and includes it in that listing's next summary email
      // instead. The candidate's own confirmation email is unaffected
      // either way — they always hear back immediately. ──
      if (path === '/apply' && request.method === 'POST') {
        const { name, candidateEmail, role, about, cv, cvFileUrl, listingId } = await request.json();
        if (!listingId || !name || !candidateEmail) {
          return jsonResponse({ error: 'Missing required fields' }, 400, ALLOWED_ORIGIN);
        }
        // Who the application goes to is decided HERE, from the listing
        // itself — never from what the browser sends. Previously the browser
        // supplied the employer's address, which meant anyone could use this
        // endpoint to send email to any address from our domain.
        const applyListingRaw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!applyListingRaw) return jsonResponse({ error: 'That job has expired or been removed' }, 404, ALLOWED_ORIGIN);
        const applyListing = JSON.parse(applyListingRaw);
        if (applyListing.kind !== 'job' || applyListing.flagged || !applyListing.data || !applyListing.data.email) {
          return jsonResponse({ error: 'That job is not accepting applications' }, 400, ALLOWED_ORIGIN);
        }
        const employerEmail = applyListing.data.email;
        const jobTitle = applyListing.data.title || '';

        if (listingId) {
          const existing = await env.FDC_STORE.list({ prefix: `application:${listingId}:` });
          for (const key of existing.keys) {
            const raw = await env.FDC_STORE.get(key.name);
            if (!raw) continue;
            const app = JSON.parse(raw);
            if ((app.candidateEmail || '').toLowerCase() === candidateEmail.toLowerCase()) {
              return jsonResponse({ sent: true, score: app.score, alreadyApplied: true }, 200, ALLOWED_ORIGIN);
            }
          }
        }

        let score = null;
        let highlights = null;
        let skipScoring = false;
        let digestMode = false;
        let jobDesc = '';
        skipScoring = !!applyListing.data.skipScoring;
        digestMode = !!applyListing.data.digestMode;
        jobDesc = applyListing.data.desc || '';

        if (!skipScoring && cv && cv.length >= 50) {
          try {
            const result = await scoreApplicantForJob({ cv, role, about, jobTitle: jobTitle || 'this role', jobDesc }, env);
            score = result.score;
            highlights = result.highlights;
          } catch (e) { /* scoring is a nice-to-have — application still goes through without it */ }
        }

        if (listingId) {
          const appId = crypto.randomUUID();
          const application = {
            id: appId, listingId, name, candidateEmail, role, about, cv, cvFileUrl: cvFileUrl || null,
            jobTitle: jobTitle || '', score, highlights, skipScoring,
            appliedAt: Date.now(),
          };
          await env.FDC_STORE.put(`application:${listingId}:${appId}`, JSON.stringify(application), { expirationTtl: 60 * 60 * 24 * 45 });
        }

        if (!digestMode) {
          const subject = `Application: ${jobTitle || 'Role'} — ${name}`;
          const scoreLine = score !== null ? `\nMatch score for this role: ${score}/100\n${(highlights || []).map(h => '- ' + h).join('\n')}\n` : '';
          const cvFileLine = cvFileUrl ? `\nAttached CV file: ${cvFileUrl}\n` : '';
          const text = `New application via Dublin Coffee Jobs\n\nRole: ${jobTitle || ''}\nName: ${name}\nEmail: ${candidateEmail}\nRole/experience: ${role || ''}\n${scoreLine}${about ? '\nNote: ' + about + '\n' : ''}${cvFileLine}\n${cv ? '\n--- CV (pasted text) ---\n' + cv + '\n' : '\n(No CV text pasted)\n'}${listingId ? `\nView the full shortlist for this job: ${env.SITE_URL}/applicants.html?listingId=${listingId}&email=${encodeURIComponent(employerEmail)}\n` : ''}`;
          await sendEmailTo(env, employerEmail, subject, text, candidateEmail);
        }
        ctx.waitUntil(sendApplicationConfirmation({ candidateEmail, name, jobTitle, score, highlights }, env));
        ctx.waitUntil(bumpStat(env, 'applications'));
        return jsonResponse({ sent: true, score }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/applicants' && request.method === 'GET') {
        const listingId = url.searchParams.get('listingId');
        const email = url.searchParams.get('email');
        if (!listingId || !email) return jsonResponse({ error: 'Missing listingId or email' }, 400, ALLOWED_ORIGIN);

        const listingRaw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!listingRaw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const listing = JSON.parse(listingRaw);
        if ((listing.data.email || '').toLowerCase() !== email.toLowerCase()) {
          return jsonResponse({ error: 'That email doesn\'t match the one this job was posted under' }, 403, ALLOWED_ORIGIN);
        }

        const list = await env.FDC_STORE.list({ prefix: `application:${listingId}:` });
        const applicants = [];
        for (const key of list.keys) {
          const raw = await env.FDC_STORE.get(key.name);
          if (raw) applicants.push(JSON.parse(raw));
        }
        applicants.sort((a, b) => {
          if (a.score === null && b.score === null) return b.appliedAt - a.appliedAt;
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return b.score - a.score;
        });

        return jsonResponse({ jobTitle: listing.data.title, skipScoring: !!listing.data.skipScoring, applicants }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/upload/image' && request.method === 'POST') {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          return jsonResponse({ error: 'Only image files are allowed' }, 400, ALLOWED_ORIGIN);
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 8 * 1024 * 1024) {
          return jsonResponse({ error: 'Image must be under 8MB' }, 400, ALLOWED_ORIGIN);
        }
        const ext = contentType.split('/')[1]?.split('+')[0] || 'jpg';
        const key = `uploads/${crypto.randomUUID()}.${ext}`;
        await env.FDC_UPLOADS.put(key, bytes, { httpMetadata: { contentType } });
        const url = `${env.R2_PUBLIC_URL}/${key}`;
        return jsonResponse({ url }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/listings/edit' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const email = url.searchParams.get('email');
        if (!id || !email) return jsonResponse({ error: 'Missing id or email' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        if ((record.data.email || '').toLowerCase() !== email.toLowerCase()) {
          return jsonResponse({ error: 'That email doesn\'t match the one this listing was posted under' }, 403, ALLOWED_ORIGIN);
        }
        // Surface the view count back to the employer here too (previously
        // only shown to the board itself) — the edit modal is the natural
        // place for an employer to check how their listing's doing.
        const viewsRaw = await env.FDC_STORE.get(`views:${id}`);
        record.views = viewsRaw ? parseInt(viewsRaw, 10) : 0;
        return jsonResponse({ record }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/listings/edit' && request.method === 'POST') {
        const { id, email, data } = await request.json();
        if (!id || !email || !data) return jsonResponse({ error: 'Missing id, email, or data' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (!raw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        if ((record.data.email || '').toLowerCase() !== email.toLowerCase()) {
          return jsonResponse({ error: 'That email doesn\'t match the one this listing was posted under' }, 403, ALLOWED_ORIGIN);
        }
        record.data = { ...record.data, ...data };
        record.editedAt = Date.now();
        const remainingTtl = record.expiresAt ? Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000)) : 60 * 60 * 24 * 14;
        await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: remainingTtl });
        return jsonResponse({ saved: true }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/applicants/remove' && request.method === 'POST') {
        const { listingId, appId, email } = await request.json();
        if (!listingId || !appId || !email) return jsonResponse({ error: 'Missing listingId, appId, or email' }, 400, ALLOWED_ORIGIN);
        const listingRaw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!listingRaw) return jsonResponse({ error: 'Listing not found or expired' }, 404, ALLOWED_ORIGIN);
        const listing = JSON.parse(listingRaw);
        if ((listing.data.email || '').toLowerCase() !== email.toLowerCase()) {
          return jsonResponse({ error: 'That email doesn\'t match the one this listing was posted under' }, 403, ALLOWED_ORIGIN);
        }
        await env.FDC_STORE.delete(`application:${listingId}:${appId}`);
        return jsonResponse({ removed: true }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/upload/file' && request.method === 'POST') {
        const contentType = request.headers.get('content-type') || 'application/octet-stream';
        const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (!allowedTypes.includes(contentType)) {
          return jsonResponse({ error: 'Only PDF or Word documents are allowed' }, 400, ALLOWED_ORIGIN);
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > 10 * 1024 * 1024) {
          return jsonResponse({ error: 'File must be under 10MB' }, 400, ALLOWED_ORIGIN);
        }
        const extMap = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
        const key = `documents/${crypto.randomUUID()}.${extMap[contentType]}`;
        await env.FDC_UPLOADS.put(key, bytes, { httpMetadata: { contentType } });
        const url = `${env.R2_PUBLIC_URL}/${key}`;
        return jsonResponse({ url }, 200, ALLOWED_ORIGIN);
      }

      return jsonResponse({ error: 'Unknown endpoint' }, 404, ALLOWED_ORIGIN);

    } catch (err) {
      return jsonResponse({ error: 'Something went wrong', detail: String(err) }, 500, ALLOWED_ORIGIN);
    }
  },

  async scheduled(event, env, ctx) {
    const alertList = await env.FDC_STORE.list({ prefix: 'alert:' });
    const listingList = await env.FDC_STORE.list({ prefix: 'listing:' });
    const listings = [];
    for (const key of listingList.keys) {
      const raw = await env.FDC_STORE.get(key.name);
      if (raw) listings.push(JSON.parse(raw));
    }

    for (const key of alertList.keys) {
      const raw = await env.FDC_STORE.get(key.name);
      if (!raw) continue;
      const alert = JSON.parse(raw);
      const matches = listings.filter(l =>
        !l.flagged &&
        l.kind === alert.kind &&
        l.createdAt > alert.lastChecked &&
        (!alert.role || (l.data.role || l.data.title || '').toLowerCase().includes(alert.role.toLowerCase())) &&
        (!alert.area || (l.data.location || l.data.area || '').toLowerCase().includes(alert.area.toLowerCase()))
      );

      if (matches.length > 0) {
        const lines = matches.map(m => `- ${m.data.title || m.data.role || 'Listing'} — ${m.data.venue || ''} ${m.data.location || m.data.area || ''}`).join('\n');
        await sendEmailTo(env, alert.email, `New matches on Dublin Coffee Jobs`, `New listings matching your saved search:\n\n${lines}\n\nView them at ${env.SITE_URL}`);
      }
      alert.lastChecked = Date.now();
      await env.FDC_STORE.put(key.name, JSON.stringify(alert), { expirationTtl: 60 * 60 * 24 * 90 });
    }

    // These two are naturally daily-cadence jobs (a digest and an
    // expiry-window reminder), but the cron trigger itself may fire more
    // often than once a day. Each function gates its own real work
    // internally so it's safe to call every scheduled run regardless of
    // how frequently the trigger actually fires.
    await runDigestJob(env, listings);
    await runRenewalReminderJob(env, listings);

    // One-off removals Ger asked for (hidden from the board, not deleted, so they can be restored).
    for (const l of listings) {
      if (l.kind === 'job' && !l.flagged && /pinecone/i.test((l.data && l.data.venue) || '')) {   // 05/11/26: old Pinecone job
        l.flagged = true; l.flagReason = 'Removed at owner request (old job)';
        await env.FDC_STORE.put(`listing:${l.id}`, JSON.stringify(l), l.expiresAt ? { expiration: Math.max(Math.floor(l.expiresAt / 1000), Math.floor(Date.now() / 1000) + 120) } : undefined);
      }
    }

    // Monday jobs scan — does a small slice each hour (see runJobScan).
    try { await runJobScan(env, listings); } catch (e) { console.error('Job scan error:', String(e)); }
    try { await runSocialQueue(env, ctx); } catch (e) { console.error('Social queue error:', String(e)); }
    try { await runSpottedLinkCheck(env, listings); } catch (e) { console.error('Link check error:', String(e)); }
  }
};

// ── HELPERS ──────────────────────────────────────────────────────

async function callClaude(prompt, env, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens || 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!data.content) {
    throw new Error('Claude API error: ' + JSON.stringify(data));
  }
  return data;
}

async function generateFullReviewResult(record, env) {
  const prompt = `You are an expert recruiter specialising in the Irish coffee and hospitality industry, working nationwide (not just Dublin).
${IRISH_HOSPITALITY_KNOWLEDGE}
Give a detailed, line-by-line review of this CV for someone applying for a ${record.role || 'barista'} role. Be specific and practical — ground your feedback in the real pay bands, certifications, and standout factors above rather than generic advice. Never let the cause of a gap, non-native English phrasing, age, gender, disability, or immigration status affect any feedback, concern, or question. Stay encouraging in tone throughout.
CV: ${record.cv}
Respond ONLY with a JSON object (no markdown, no backticks):
{"lineNotes":["specific note on one part of the CV","...","..."],"rewrittenSummary":"<a rewritten 2-4 sentence professional summary/personal statement for this candidate, ready to paste at the top of their CV>","potentialConcerns":["a genuine, fair concern an employer might raise, stated neutrally without speculating on cause","...","..."],"estimatedSalary":"<a realistic Irish pay range for this candidate right now, using the pay bands above>","interviewQuestions":["a targeted interview question this candidate should prepare for, based on their specific CV","...","...","...","..."]}`;
  const data = await callClaude(prompt, env);
  const text = data.content.map(i => i.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function scoreApplicantForJob({ cv, role, about, jobTitle, jobDesc }, env) {
  const prompt = `You are screening a job application for an Irish hospitality/coffee employer. Score how well this specific candidate fits this specific role — not a generic template.
Role applied for: ${jobTitle}
${jobDesc ? `Role description: ${jobDesc}` : ''}
Candidate's stated role/experience: ${role || 'not given'}
Candidate's note: ${about || 'none'}
Candidate's CV: ${cv}
Score 0-100 on fit for this exact role, and give 2-3 short highlight bullets (max ~12 words each) an employer could scan in a few seconds — the most relevant strengths or flags for this specific role. Never let a gap's cause, non-native English phrasing, age, gender, disability, or immigration status affect the score.
Respond ONLY with JSON, no markdown: {"score":<0-100>,"highlights":["...","...","..."]}`;
  const data = await callClaude(prompt, env, 500);
  const text = data.content.map(i => i.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Saves a listing while keeping its original expiry. (Plain puts without
// an expiry used to make a flagged/restored listing live forever.)
async function putListing(env, record) {
  const opts = {};
  if (record.expiresAt) opts.expirationTtl = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000));
  await env.FDC_STORE.put(`listing:${record.id}`, JSON.stringify(record), opts);
}

async function hashText(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
  });
}

async function hasActiveSubscription(email, env) {
  try {
    const custRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=3`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!custRes.ok) return false;
    const custData = await custRes.json();
    for (const customer of (custData.data || [])) {
      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=5`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (!subRes.ok) continue;
      const subData = await subRes.json();
      if ((subData.data || []).some(s => s.items.data.some(i => i.price.id === PRICE_IDS.job_retainer))) return true;
    }
    return false;
  } catch (e) { return false; }
}

async function createStripeCheckoutSession({ priceId, listingId, email, successUrl, cancelUrl }, env) {
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('allow_promotion_codes', 'true');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('metadata[listingId]', listingId);
  if (email) params.append('customer_email', email);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) throw new Error('Stripe session creation failed: ' + await res.text());
  return res.json();
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === signature;
}

function contactRevealText(d) {
  return `Here are the contact details for this available staff member:\n\nRole: ${d.role || 'Barista'}\nArea: ${d.area || ''}\n${d.rate ? 'Min. rate: ' + d.rate + '\n' : ''}\nEmail: ${d.email || 'not provided'}\n${d.whatsapp ? 'WhatsApp: ' + d.whatsapp + '\n' : ''}\nReach out directly — this is between you and them from here.`;
}

// One wording for every listing type, used by both the automatic
// Facebook Page / Instagram post and the Group paste email.
function listingCaption(record, env) {
  const d = record.data || {};
  const join = (...parts) => parts.filter(p => p && String(p).trim()).join(' · ');
  if (record.kind === 'job' && record.roundup) {
    const url = `${env.SITE_URL}/job-board.html?id=${record.id}`;
    return { url, title: d.title, text: `Now hiring: ${d.venue}\n${d.roundupLine || ''}\n\nSee the roles: ${url}` };
  }
  if (record.kind === 'job') {
    const url = `${env.SITE_URL}/job-board.html?id=${record.id}`;
    return { url, title: d.title, text: `New job: ${d.title} at ${d.venue}\n${join(d.location, d.salary, d.type)}\n\nApply: ${url}` };
  }
  const url = `${env.SITE_URL}/shift-cover.html?id=${record.id}`;
  if (record.kind === 'shift_available') {
    const days = Array.isArray(d.availability) ? d.availability.join(', ') : d.availability;
    return { url, title: `${d.role || 'Staff'} available`, text: `Available for shifts: ${d.role || 'hospitality staff'}${d.years ? ' (' + d.years + ' yrs experience)' : ''}\n${join(d.area, days, d.rate ? 'from ' + d.rate : '')}\n\nShort-staffed? Get in touch free: ${url}` };
  }
  return { url, title: d.role, text: `Shift cover needed: ${d.role} at ${d.venue}\n${join(d.location, [d.date, d.hours].filter(Boolean).join(' '), d.rate)}\n\nDetails: ${url}` };
}

async function notifyGroupPost(record, env) {
  if (!env.ALERT_EMAIL_TO) return;
  const { title, text: caption } = listingCaption(record, env);
  await sendEmailTo(env, env.ALERT_EMAIL_TO, `Paste into the DCJ Group: ${title}`, `A new listing just went live and posted to Instagram + the Facebook Page automatically.\n\nThe Facebook Group still needs a manual paste (Meta doesn't allow apps to auto-post into Groups) — here's the text, ready to copy:\n\n---\n${caption}\n---`);
}

async function sendListingConfirmation(record, env) {
  const d = record.data;
  if (!d.email) return;
  const isJob = record.kind === 'job';
  const isAvailable = record.kind === 'shift_available';
  const url = isJob
    ? `${env.SITE_URL}/job-board.html?id=${record.id}`
    : `${env.SITE_URL}/shift-cover.html?id=${record.id}`;
  const title = isJob ? d.title : (isAvailable ? `${d.role} — available for shifts` : `${d.role} — shift cover needed`);
  const subject = `Your listing is live: ${title}`;
  const editNote = isAvailable
    ? `Want to update or remove this later? Go to ${env.SITE_URL}/shift-cover.html, click "Edit a listing", and enter:\n\nListing ID: ${record.id}\nEmail: ${d.email}`
    : `Want to make a change later? Go to ${isJob ? env.SITE_URL + '/job-board.html' : env.SITE_URL + '/shift-cover.html'}, click "Edit a listing", and enter:\n\nListing ID: ${record.id}\nEmail: ${d.email}`;
  const text = `Your listing is now live on Dublin Coffee Jobs.\n\n${title}${d.venue ? ' at ' + d.venue : ''}\n${d.location || d.area || ''}\n\nView it: ${url}\n\n${editNote}\n\nQuestions — just reply to this email.`;
  await sendEmailTo(env, d.email, subject, text);
}

// Confirms to the candidate that their application was sent, and shows
// them their own match score + highlights for this specific job — they
// were never shown this before, only the employer was. Kept low-key and
// encouraging, consistent with the CV Reviewer's tone rules elsewhere: a
// score is informational, one factor among many, never a verdict.
async function sendApplicationConfirmation({ candidateEmail, name, jobTitle, score, highlights }, env) {
  if (!candidateEmail) return;
  const subject = `Your application to ${jobTitle || 'the role'} was sent`;
  const scoreLine = score !== null
    ? `\nFor reference, here's how your application matched this specific role:\n\nMatch score: ${score}/100\n${(highlights || []).map(h => '- ' + h).join('\n')}\n\nThis is just a quick reference for the employer — one factor among many, not a verdict.\n`
    : '';
  const text = `Hi ${name || ''},\n\nYour application to ${jobTitle || 'this role'} has been sent to the employer.\n${scoreLine}\nGood luck!\n\n— Dublin Coffee Jobs`;
  await sendEmailTo(env, candidateEmail, subject, text);
}

// Runs at most once roughly every ~23 hours (gated on a stored
// timestamp, since the cron trigger itself may fire more often). For
// every non-flagged job/shift listing with digestMode on, gathers any
// applications received since that listing's last digest email and, if
// there are any, sends one ranked summary email. Per-listing "last sent"
// state is tracked in digestSent:<id> rather than a global timestamp, so
// a listing posted partway through the day still gets its first digest
// covering everything since it went live, not since the last global run.
async function runDigestJob(env, listings) {
  const lastRunRaw = await env.FDC_STORE.get('digest:lastRun');
  const lastRun = lastRunRaw ? parseInt(lastRunRaw, 10) : 0;
  const NEARLY_A_DAY = 23 * 60 * 60 * 1000;
  if (Date.now() - lastRun < NEARLY_A_DAY) return;
  await env.FDC_STORE.put('digest:lastRun', String(Date.now()));

  for (const listing of listings) {
    if (listing.flagged || !listing.data || !listing.data.digestMode || !listing.data.email) continue;

    const sinceRaw = await env.FDC_STORE.get(`digestSent:${listing.id}`);
    const since = sinceRaw ? parseInt(sinceRaw, 10) : (listing.createdAt || 0);

    const appList = await env.FDC_STORE.list({ prefix: `application:${listing.id}:` });
    const fresh = [];
    for (const appKey of appList.keys) {
      const appRaw = await env.FDC_STORE.get(appKey.name);
      if (!appRaw) continue;
      const app = JSON.parse(appRaw);
      if (app.appliedAt > since) fresh.push(app);
    }

    if (fresh.length > 0) {
      fresh.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      const lines = fresh.map(a => `- ${a.name}${a.score !== null && a.score !== undefined ? ` — match ${a.score}/100` : ''} (${a.candidateEmail})`).join('\n');
      const title = listing.data.title || listing.data.role || 'your listing';
      const shortlistUrl = `${env.SITE_URL}/applicants.html?listingId=${listing.id}&email=${encodeURIComponent(listing.data.email)}`;
      await sendEmailTo(env, listing.data.email,
        `Daily digest: ${fresh.length} new application${fresh.length > 1 ? 's' : ''} — ${title}`,
        `${fresh.length} new application${fresh.length > 1 ? 's' : ''} came in for ${title}${listing.data.venue ? ' at ' + listing.data.venue : ''} in the last day, ranked by match score:\n\n${lines}\n\nView the full shortlist: ${shortlistUrl}\n\nYou're getting one email a day instead of one per applicant because digest mode is turned on for this listing — change it any time from "Edit a listing".`);
    }
    await env.FDC_STORE.put(`digestSent:${listing.id}`, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 60 });
  }
}

// Runs at most once roughly every ~23 hours, same gating pattern as the
// digest job above (separate timestamp key so the two don't interfere).
// Finds paid job/shift listings expiring within the next 2 days that
// haven't already had a reminder sent, and emails a one-click renew link
// — opens the post form on the site pre-filled with this listing's
// details via /listings/lookup, ready to pay and go live again as a
// fresh listing. renewReminderSent guarantees at most one reminder per
// listing; it's cleared again if the listing is later manually extended
// via /admin/listing (see extendDays handling above).
async function runRenewalReminderJob(env, listings) {
  const lastRunRaw = await env.FDC_STORE.get('renewalReminder:lastRun');
  const lastRun = lastRunRaw ? parseInt(lastRunRaw, 10) : 0;
  const NEARLY_A_DAY = 23 * 60 * 60 * 1000;
  if (Date.now() - lastRun < NEARLY_A_DAY) return;
  await env.FDC_STORE.put('renewalReminder:lastRun', String(Date.now()));

  const WINDOW = 2 * 24 * 60 * 60 * 1000;

  for (const listing of listings) {
    if (listing.flagged || listing.renewReminderSent) continue;
    if (listing.kind !== 'job' && listing.kind !== 'shift_need') continue; // not "available" posts — those aren't paid listings to renew
    if (!listing.expiresAt || !listing.data || !listing.data.email) continue;

    const remaining = listing.expiresAt - Date.now();
    if (remaining <= 0 || remaining > WINDOW) continue;

    const title = listing.data.title || listing.data.role || 'Your listing';
    const isJob = listing.kind === 'job';
    const renewUrl = isJob
      ? `${env.SITE_URL}/job-board.html?renew=${listing.id}`
      : `${env.SITE_URL}/shift-cover.html?renew=${listing.id}`;
    const daysLeft = Math.max(1, Math.ceil(remaining / (24 * 60 * 60 * 1000)));

    await sendEmailTo(env, listing.data.email,
      `${title} expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''} — renew it?`,
      `${title}${listing.data.venue ? ' at ' + listing.data.venue : ''} expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}.\n\nStill hiring or still need cover? Renew it in one click — it opens a fresh post pre-filled with these details, ready to pay and go live again:\n\n${renewUrl}\n\nIf you're all sorted, no action needed — it'll just expire quietly and this is the only reminder you'll get for it.`);

    listing.renewReminderSent = true;
    const remainingTtl = Math.max(60, Math.floor((listing.expiresAt - Date.now()) / 1000));
    await env.FDC_STORE.put(`listing:${listing.id}`, JSON.stringify(listing), { expirationTtl: remainingTtl });
  }
}

const SOCIAL_IMAGE_COUNT = 66;

// Advances the shared rotation counter and returns the next photo in the
// 66-image set. Split out from pickSocialImage so a manual admin post
// (which has no "record" at all) can fall back to the same rotation as
// listing auto-posts, instead of needing its own separate counter.
async function nextRotationImage(env) {
  const raw = await env.FDC_STORE.get('social:image-counter');
  const current = raw ? parseInt(raw, 10) : 0;
  const index = (current % SOCIAL_IMAGE_COUNT) + 1;
  await env.FDC_STORE.put('social:image-counter', String(current + 1));
  return `${env.SITE_URL}/${index}.jpg`;
}

async function pickSocialImage(record, env) {
  const custom = record.data && record.data.imageUrl && String(record.data.imageUrl).trim();
  if (custom) return custom;
  return nextRotationImage(env);
}

// Exchanges the long-lived System User token (stored as
// FB_PAGE_ACCESS_TOKEN) for a genuine Page-scoped access token, fresh,
// every time this is called. Facebook's /{page-id}/photos and /feed
// endpoints require an actual Page token — a System User's own token,
// even with Full access to the Page as a business asset, gets rejected
// with a misleading "publish_actions deprecated" error rather than a
// clear one. This exchange is the standard documented pattern for
// System User → Page posting (see developers.facebook.com/docs/pages
// /access-tokens) and means the Cloudflare secret only ever needs to
// hold the non-expiring System User token — never a separate Page token
// that would need manually regenerating and re-pasting later.
async function getPageAccessToken(env) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}?fields=access_token&access_token=${env.FB_PAGE_ACCESS_TOKEN}`);
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Could not exchange for a Page access token: ' + JSON.stringify(data).slice(0, 300));
  }
  return data.access_token;
}

// Shared posting core — does the actual Facebook Page + Instagram API
// calls for a given image + caption (+ optional link, used for the FB
// text-only fallback when the photo post fails). Used by BOTH the
// automatic per-listing postToSocial() below AND the manual admin
// "post anything" tool (see /admin/post-social), so there's exactly one
// place that knows how to talk to the Graph API rather than two copies
// that could drift apart. Returns a per-platform result object instead
// of just logging, so a manual post can show the admin real feedback
// rather than blind "it probably worked."
async function postImageAndCaptionToSocial({ imageUrl, caption, link }, env) {
  const result = { facebook: { ok: false, detail: '' }, instagram: { ok: false, detail: '' } };

  if (!env.FB_PAGE_ACCESS_TOKEN || !env.FB_PAGE_ID) {
    const detail = 'Not configured — missing FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID';
    console.error('postImageAndCaptionToSocial:', detail);
    result.facebook.detail = detail;
    result.instagram.detail = detail;
    return result;
  }

  // Instagram's endpoints have worked fine with the raw System User
  // token directly, so only the Facebook Page calls below need the
  // exchanged Page token. If the exchange itself fails, Facebook is
  // marked failed with a clear reason but Instagram still proceeds
  // normally further down — the two platforms are independent.
  let pageToken = null;
  try {
    pageToken = await getPageAccessToken(env);
  } catch (e) {
    result.facebook.detail = String(e).slice(0, 300);
    console.error('postImageAndCaptionToSocial: Page token exchange failed:', String(e));
  }

  if (pageToken) {
  try {
    const photoRes = await fetch(`https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: imageUrl, caption, access_token: pageToken }).toString(),
    });
    if (!photoRes.ok) {
      const errBody = await photoRes.text();
      throw new Error('FB photo post failed: ' + photoRes.status + ' ' + errBody);
    }
    result.facebook = { ok: true, detail: 'Posted with photo' };
    console.log('postImageAndCaptionToSocial: Facebook photo post OK');
  } catch (e) {
    console.error('postImageAndCaptionToSocial: Facebook photo post failed, trying text fallback:', String(e));
    try {
      const feedBody = { message: caption, access_token: pageToken };
      if (link) feedBody.link = link;
      const feedRes = await fetch(`https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(feedBody).toString(),
      });
      if (!feedRes.ok) {
        const errBody = await feedRes.text();
        result.facebook = { ok: false, detail: 'Photo post AND text fallback both failed: ' + errBody.slice(0, 300) };
        console.error('postImageAndCaptionToSocial: Facebook text fallback ALSO failed:', feedRes.status, errBody);
      } else {
        result.facebook = { ok: true, detail: 'Photo post failed, posted as text instead' };
        console.log('postImageAndCaptionToSocial: Facebook text fallback OK');
      }
    } catch (e2) {
      result.facebook = { ok: false, detail: 'Threw an exception: ' + String(e2).slice(0, 300) };
      console.error('postImageAndCaptionToSocial: Facebook text fallback threw an exception:', String(e2));
    }
  }
  }

  try {
    if (env.IG_USER_ID) {
      const createRes = await fetch(`https://graph.facebook.com/v19.0/${env.IG_USER_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrl, caption, access_token: env.FB_PAGE_ACCESS_TOKEN }).toString(),
      });
      const created = await createRes.json();
      if (created.id) {
        // Instagram processes the image asynchronously after creation —
        // publishing immediately can hit "media not ready" if that
        // processing hasn't finished yet (a real race condition, not a
        // permissions issue). Poll the container's own status_code first
        // and only publish once Instagram itself reports it's ready,
        // rather than guessing with a fixed delay.
        let mediaReady = false;
        let lastStatus = 'UNKNOWN';
        for (let attempt = 0; attempt < 10; attempt++) {
          const statusRes = await fetch(`https://graph.facebook.com/v19.0/${created.id}?fields=status_code&access_token=${env.FB_PAGE_ACCESS_TOKEN}`);
          const statusJson = await statusRes.json();
          lastStatus = statusJson.status_code || lastStatus;
          if (lastStatus === 'FINISHED') { mediaReady = true; break; }
          if (lastStatus === 'ERROR') break;
          await new Promise(r => setTimeout(r, 1000));
        }

        if (!mediaReady) {
          result.instagram = { ok: false, detail: `Media never finished processing (last status: ${lastStatus}) — try again in a minute` };
          console.error('postImageAndCaptionToSocial: Instagram media not ready after polling, status:', lastStatus);
        } else {
          const publishRes = await fetch(`https://graph.facebook.com/v19.0/${env.IG_USER_ID}/media_publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ creation_id: created.id, access_token: env.FB_PAGE_ACCESS_TOKEN }).toString(),
          });
          const publishResult = await publishRes.json();
          if (publishRes.ok) {
            result.instagram = { ok: true, detail: 'Posted' };
            console.log('postImageAndCaptionToSocial: Instagram post OK', JSON.stringify(publishResult));
          } else {
            result.instagram = { ok: false, detail: 'Publish step failed: ' + JSON.stringify(publishResult).slice(0, 300) };
            console.error('postImageAndCaptionToSocial: Instagram publish step failed:', publishRes.status, JSON.stringify(publishResult));
          }
        }
      } else {
        result.instagram = { ok: false, detail: 'Media creation failed — no id returned: ' + JSON.stringify(created).slice(0, 300) };
        console.error('postImageAndCaptionToSocial: Instagram media creation failed — no id returned:', JSON.stringify(created));
      }
    } else {
      result.instagram = { ok: false, detail: 'IG_USER_ID not set — skipped' };
      console.error('postImageAndCaptionToSocial: IG_USER_ID not set — skipping Instagram');
    }
  } catch (e) {
    result.instagram = { ok: false, detail: 'Threw an exception: ' + String(e).slice(0, 300) };
    console.error('postImageAndCaptionToSocial: Instagram step threw an exception:', String(e));
  }

  return result;
}

async function postToSocial(record, env) {
  const { url, text } = listingCaption(record, env);
  const caption = `${text}\n\n#DublinJobs #HospitalityJobs #DublinCoffeeJobs`;

  const imageUrl = await pickSocialImage(record, env);
  console.log('postToSocial: starting for listing', record.id, 'imageUrl:', imageUrl);
  await postImageAndCaptionToSocial({ imageUrl, caption, link: url }, env);
}

async function sendEmailTo(env, to, subject, text, replyTo) {
  const payload = {
    from: 'Dublin Coffee Jobs <alerts@firstdraftcoffee.net>',
    to: [to],
    subject,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Resend send FAILED:', res.status, errBody, 'to:', to, 'subject:', subject);
    } else {
      const okBody = await res.json();
      console.log('Resend send OK:', to, subject, JSON.stringify(okBody));
    }
  } catch (e) {
    console.error('Resend send threw an exception:', String(e), 'to:', to, 'subject:', subject);
  }
}

async function sendAlertEmail(env, { subject, text }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dublin Coffee Jobs Alerts <alerts@firstdraftcoffee.net>',
        to: [env.ALERT_EMAIL_TO],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Resend alert send FAILED:', res.status, errBody, 'subject:', subject);
    } else {
      const okBody = await res.json();
      console.log('Resend alert send OK:', subject, JSON.stringify(okBody));
    }
  } catch (e) {
    console.error('Resend alert send threw an exception:', String(e), 'subject:', subject);
  }
}

// ═══════════════════════════════════════════════════════════════════
// WEEKLY JOB SCAN — finds roles on employers' own careers pages,
// emails Ger a list every Monday morning, and posts each one he
// approves with one tap. Runs entirely inside this Worker, so no
// passwords or tokens ever leave Cloudflare.
//
// How a Monday goes (the hourly cron calls runJobScan every hour; it
// does a small slice of work each time so it never hits Worker limits):
//   from 01:00 Dublin  scan 4 employers per hour, saving new roles as drafts
//   after scanning     find careers pages for unconfirmed employers, then
//                      search the web for up to 10 new employers
//   from 08:00 Dublin  email Ger the list: one "Check & post" link per
//                      role, plus "Post all"
// Approve links open a confirm page; posting needs a button press, so
// email security scanners that "click" links can't post anything.
// KV keys: scan:employers (the list), scan:state (this week's progress),
// scan:draft:<id> (a found role, 14 days), scan:seen:<hash> (already
// offered, 45 days, so Ger isn't asked twice).
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_SCAN_EMPLOYERS = [
  { name: "The Butler's Pantry", type: 'Food shops & bakery, Dublin', url: 'https://thebutlerspantry.ie/careers/' },   // from Ger 14/11/26; jobs listed on their own site
  { name: 'Insomnia Coffee Company', type: 'Café chain', url: 'https://api.occupop.com/api/jobs-frame/urV593LGChLdVuTZF1RVKNFOCYqXgWWeafinbwpeJ782LQaNNn?&search=1&visibility=external&fields=title,type,location', alsoWatch: true },   // 14/11/26: reads the Occupop job list that insomnia.ie/careers embeds; still on the invite watch list as backup
  { name: 'EUROSPAR Prendergast Group', type: 'Retail coffee counters', url: 'https://eurosparcareers.recruitee.com' },
  { name: 'Centra', type: 'Retail coffee counters (each shop hires itself)', url: '', formOnly: true },
  // No confirmed careers page yet — the discovery step looks for one.
  ...['CH&CO', 'Aramark Ireland', 'Sodexo Ireland',
    'Costa Coffee Ireland', 'Eclective Hospitality Group', 'Java Republic', "Brady's Coffee",
    'Velo Coffee Roasters', 'Flat Coffee', 'Imbibe Coffee Roasters', 'Soma Coffee Company']
    .map(name => ({ name, type: '', url: '' })),
  // Added 02/11/26 — Irish coffee chains and well-known independents.
  // Discovery checks each for a careers page that lists actual jobs; any
  // that only have a general "send your CV" form go on the invite
  // watch list instead (see findInviteLeads).
  ...['Póg', 'Esquires Coffee Ireland', "Bewley's Ireland",
    'Butlers Chocolate Café', 'Caffè Nero Ireland', 'Starbucks Ireland', "Gloria Jean's Coffees Ireland", 'AMT Coffee Ireland',
    'Joe & The Juice Ireland', '3fe Coffee', 'Two Boys Brew', 'Brother Hubbard', 'Bread 41', 'Shoe Lane Coffee',
    'Proper Order Coffee Co.', 'Kaph', 'Clement & Pekoe', 'Cloud Picker Coffee', 'Roasted Brown', 'Bear Market Coffee',
    'Vice Coffee Inc.', 'Network Café Dublin', 'Two Pups Coffee', 'Badger & Dodo (Cork)', 'Filter Espresso & Coffee Brewing Specialists (Cork)',
    'Golden Bean Coffee (Kerry)', 'Coffeewerk + Press (Galway)']
    .map(name => ({ name, type: 'Coffee', url: '' })),
  { name: 'Griolladh', type: 'Toastie & coffee chain', url: '', formOnly: true },
  // Added 03/11/26 — big readable careers sites (capped at 3 roles a week each in the email).
  { name: 'Dalata Hotel Group (Clayton & Maldron hotels)', type: 'Hotels', url: 'https://careers.dalatahotelgroup.com/jobs',
    pages: { template: 'https://careers.dalatahotelgroup.com/jobs?paged={p}', from: 2, step: 1, count: 5 } },
  { name: 'Boojum', type: 'Burrito restaurants', url: 'https://boojumltd.teamtailor.com/jobs' },
  { name: 'The Natural Bakery', type: 'Bakery-cafés', url: 'https://thenaturalbakery.ie/careers/' },
  { name: 'Twobeans Speciality Coffee Bar (Dún Laoghaire)', type: 'Specialty coffee', url: 'https://www.twobeans.ie/jobs' },
  { name: 'Ground Coffee (Northern Ireland)', type: 'Coffee shops', url: 'https://groundcoffee.net/work-us/' },
  { name: "Bewley's Grafton Street", type: 'Café', url: 'https://bewleysgraftonstreet.com/work-with-us/' },
  { name: 'Avoca', type: 'Cafés & food halls', url: 'https://avoca.com/pages/careers-at-avoca', alsoWatch: true },   // jobs load in after the page opens
  { name: 'Bodega (Howth)', type: 'Specialty coffee', url: 'https://www.bodega.ie/hiring' },
  { name: 'The Bookshelf Coffee House (Cork & Kerry)', type: 'Café', url: 'https://bookshelfcoffee.com/jobs' },
  { name: 'Brentwood Coffee', type: 'Coffee shops', url: 'https://www.brentwoodcoffee.ie/careers' },
  { name: 'Foam Coffeehouse', type: 'Café', url: 'https://foamcoffeehouse.ie/careers-at-foam-coffeehouse/' },
  { name: 'Mocha Beans (Galway)', type: 'Roaster, cafés & bakery', url: 'https://mochabeans.com/pages/careers' },
  { name: 'BaxterStorey', type: 'Contract catering', url: 'https://baxterstorey.ie/begin-your-story/' },   // SmartRecruiters (shared UK account, Irish jobs only)
  { name: 'Compass Group Ireland (Gather & Gather)', type: 'Contract catering', url: 'https://jobs.compass-group.co.uk/compass-ireland', alsoWatch: true },   // runs on inploi, jobs load in later — likely unreadable
  { name: 'Scéal Bakery', type: 'Bakery', url: 'https://www.scealbakery.com/careers', alsoWatch: true },   // not checked by hand (link too long to open); email flags it if unreadable
  { name: 'Café Sol', type: 'Coffee shops & Dunnes kiosks', url: '', formOnly: true },
  { name: 'Coffeeangel', type: 'Specialty coffee', url: '', formOnly: true },   // careers page has no job list (checked 03/11/26)
  { name: 'The Art of Coffee', type: 'Specialty coffee shops, Dublin', url: '', formOnly: true },   // no own careers page found (13/11/26); hires via job sites, so watched for invites
  { name: 'Mister Magpie Coffee', type: 'Specialty coffee, Dublin', url: '', formOnly: true },   // no own careers page found (13/11/26); always hiring via job sites, so watched for invites
  { name: 'Eclective Hospitality', type: 'Restaurant & bar group (Elephant & Castle, Captain Americas…)', url: '', formOnly: true },   // careers page has no job list (13/11/26)
  { name: 'Behind the Label Coffee Roasters', type: 'Coffee roaster, Dublin', url: '', formOnly: true },   // hiring 14/11/26 (Ger); no careers page or public email
  { name: 'UCC Coffee Ireland', type: 'Coffee roaster & supplier', url: '', formOnly: true },   // hiring 14/11/26 (Ger); jobs on job sites only
  { name: 'Silverskin Coffee Roasters', type: 'Coffee roaster, Dublin 10', url: '', formOnly: true },   // no own careers page found (13/11/26); watched for invites
];
const SCAN_START_HOUR = 1;
// One-off extra scan days on top of every Monday (YYYY-MM-DD, Dublin time).
const EXTRA_SCAN_DATES = ['2026-11-03', '2026-11-04', '2026-11-14'];   // 14/11: bonus run so Saturday's new jobs and invites go out today
// Regular scan days (Dublin time): scans overnight, email lands around 8am Tue & Fri.
const SCAN_DAYS = ['Tue', 'Fri'];
const SCAN_EMAIL_HOUR = 8;
const BLOCKED_JOB_SITES = /(^|\.)(indeed\.|linkedin\.|jobs\.ie|irishjobs\.ie|jobsireland\.ie|glassdoor\.|ziprecruiter\.|simplyhired\.|jobijoba\.|cv-library\.|recruitireland\.|monster\.)/i;

function dublinNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { weekday: parts.weekday, hour: parseInt(parts.hour, 10), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return '';
    if (/["'<>\s]/.test(x.href)) return '';
    return x.href;
  } catch { return ''; }
}

async function getScanEmployers(env) {
  const raw = await env.FDC_STORE.get('scan:employers');
  const list = raw ? JSON.parse(raw) : [];
  // Anything added to the built-in list later is merged in by name, so
  // new names reach the live list without losing what discovery found.
  // Employers confirmed (02/11/26) to advertise only on job sites, not their own:
  for (const e of list) if (e.name.toLowerCase() === 'centra' && e.url) { e.url = ''; e.formOnly = true; }
  // Taken off the scan at Ger's request (05/11/26: Pinecone's careers page shows an old job).
  const REMOVED = ['pinecone coffee'];
  for (let i = list.length - 1; i >= 0; i--) if (REMOVED.includes(list[i].name.toLowerCase())) list.splice(i, 1);
  // A careers link added to the built-in list fills in a saved entry that had none.
  const byName = new Map(list.map(e => [e.name.toLowerCase(), e]));
  for (const d of DEFAULT_SCAN_EMPLOYERS) {
    const e = byName.get(d.name.toLowerCase());
    if (e && !e.url && d.url) { e.url = d.url; e.formOnly = false; if (d.pages) e.pages = d.pages; }
    if (e && d.alsoWatch) e.alsoWatch = true;
    if (e && d.url && /api\.occupop\.com/.test(d.url) && e.url && !/occupop/.test(e.url)) e.url = d.url;   // Insomnia: use its readable job list
    if (e && d.formOnly && !d.url && e.url && /coffeeangel\.com/.test(e.url)) e.url = '';   // a found page with no job list
    if (e && !e.url && d.formOnly) e.formOnly = true;
  }
  const have = new Set(list.map(e => e.name.toLowerCase()));
  for (const e of DEFAULT_SCAN_EMPLOYERS) if (!have.has(e.name.toLowerCase())) list.push({ ...e });
  return list;
}

// Called on every cron run; does nothing outside scan days (Tue, Fri, extras).
async function runJobScan(env, listings, now = new Date()) {
  if (!env.ANTHROPIC_API_KEY || !env.ALERT_EMAIL_TO) return;
  const t = dublinNow(now);
  if ((!SCAN_DAYS.includes(t.weekday) && !EXTRA_SCAN_DATES.includes(t.date)) || t.hour < SCAN_START_HOUR) return;

  const stateRaw = await env.FDC_STORE.get('scan:state');
  let state = stateRaw ? JSON.parse(stateRaw) : null;
  if (!state || state.week !== t.date) {
    // Keep last run's state for 14 days so its "Post all" / "Invite all" links still work.
    if (state) await env.FDC_STORE.put(`scan:state:${state.week}`, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 14 });
    state = { week: t.date, phase: 'scan', cursor: 0, drafts: [], allToken: randomToken(), notes: [], addedEmployers: [], leads: [] };
  }
  const save = () => env.FDC_STORE.put('scan:state', JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 14 });

  if (state.phase === 'scan') {
    // Only employers with a careers link need scanning (the rest are found by
    // discovery or invites). Spread them over ~5 hourly runs so it's done well
    // before 8am, never more than 12 per run (Worker limits).
    const employers = (await getScanEmployers(env)).filter(e => e.url);
    const batch = Math.min(12, Math.max(4, Math.ceil(employers.length / 5)));
    const slice = employers.slice(state.cursor, state.cursor + batch);
    for (const emp of slice) {
      if (!emp.url) continue;
      try {
        const roles = await scanEmployer(emp, env);
        if (!roles.length && emp._thinPage) state.notes.push(`${emp.name}: their careers page shows no readable job list (it probably loads in after the page opens).`);
        for (const role of roles) {
          const id = await saveDraftIfNew(role, emp, listings, state, env);
          if (id) state.drafts.push(id);
        }
      } catch (e) {
        console.error('Job scan failed for', emp.name, String(e));
        state.notes.push(`Couldn't read ${emp.name}'s careers page this week.`);
      }
    }
    state.cursor += batch;
    if (state.cursor >= employers.length) state.phase = 'discover';
    await save();
    return;
  }

  if (state.phase === 'discover') {
    try {
      state.addedEmployers = await discoverEmployers(env);
    } catch (e) {
      console.error('Employer discovery failed:', String(e));
      state.notes.push(`Couldn't search for new employers this time. Reason: ${String(e.message || e).slice(0, 220)}`);
    }
    state.phase = isFreeLaunch(env) ? 'leads' : 'ready';
    await save();
    return;
  }

  if (state.phase === 'leads') {
    try {
      state.leads = await findInviteLeads(env, listings, state);
    } catch (e) {
      console.error('Invite lead search failed:', String(e));
      state.notes.push(`Couldn't look for employers to invite this time. Reason: ${String(e.message || e).slice(0, 220)}`);
    }
    state.phase = 'ready';
    await save();
    return;
  }

  if (state.phase === 'ready' && t.hour >= SCAN_EMAIL_HOUR) {
    try { state.numbers = await weeklyNumbers(env, listings); } catch (e) { state.numbers = null; }
    await sendScanEmail(state, env);
    state.phase = 'emailed';
    await save();
  }
}

// Fetches one careers page and asks Claude to pick out the relevant roles.
async function scanEmployer(emp, env) {
  const pageUrl = cleanUrl(emp.url);
  if (!pageUrl) return [];
  let text = '', links = [];

  // Many employers run their jobs through a hiring platform, often loaded
  // into their careers page after it opens. We spot the platform (from the
  // link itself or from the page's code) and read its public job feed.
  let ats = detectAts(pageUrl, '');
  let html = '';
  let offers = null;
  if (ats) {
    try { offers = await fetchAtsOffers(ats); } catch (e) { console.log('Job feed failed, reading the page instead:', emp.name, String(e)); ats = null; }
  }
  if (!ats) {
    html = await fetchPageHtml(pageUrl);
    ats = detectAts(pageUrl, html);
    if (ats) { try { offers = await fetchAtsOffers(ats); } catch (e) { ats = null; } }
    // Careers sites that split jobs over several pages (e.g. Dalata).
    if (!ats && emp.pages && emp.pages.template) {
      const { template, from = 2, step = 1, count = 4 } = emp.pages;
      for (let i = 0; i < Math.min(count, 8); i++) {
        const u = cleanUrl(template.replace('{p}', String(from + i * step)));
        if (!u) break;
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'DublinCoffeeJobsBot/1.0 (+https://dublincoffeejobs.com)', 'Accept': 'text/html' } });
          if (!r.ok) break;
          html += '\n' + (await r.text()).slice(0, 150000);
        } catch { break; }
      }
    }
  }

  if (ats && offers) {
    offers = offers.slice(0, 60);
    text = JSON.stringify(offers);
    links = offers.map(o => ({ text: o.title, href: cleanUrl(o.link) })).filter(l => l.href);
  } else {
    const seen = new Set();
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let href; try { href = cleanUrl(new URL(m[1], pageUrl).href); } catch { continue; }
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      links.push({ text: label, href });
      if (links.length >= 400) break;
    }
    text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').slice(0, 45000);
    emp._thinPage = text.length < 2500;   // little readable text: jobs probably load in later
    if (emp._thinPage) {
      // Website builders often hold the page's content as data rather than
      // visible text. Try their data versions before giving up.
      const extra = await readBuilderData(pageUrl, html);
      if (extra.links.length) {
        const seenLinks = new Set(links.map(l => l.href));
        for (const l of extra.links) if (!seenLinks.has(l.href)) { links.push(l); seenLinks.add(l.href); }
      }
      if (extra.text) text = (text + '\n' + extra.text).slice(0, 45000);
      emp._thinPage = text.length < 2500;
    }
  }

  const prompt = `You are helping a coffee and hospitality jobs board in Ireland.
Below is the careers page of "${emp.name}" (${pageUrl}), plus the links on it.
List the CURRENT job openings that are (a) located on the island of Ireland (the Republic or Northern Ireland) and (b) front-line coffee, café, hospitality or kitchen roles: barista, head barista, café or shop manager/supervisor, team member/customer assistant in a café or coffee counter, roaster, roastery or production assistant, coffee packing and green coffee roles at a roastery, coffee trainer, coffee/wholesale sales, waiting staff, bartender, chef, baker, kitchen porter, hotel front-of-house and similar.
Leave out head office, IT, finance, warehouse, driving and retail roles with no café, food or coffee-roasting element (production, packing and dispatch jobs at a coffee roastery or bakery DO count). Leave out anything that is not clearly an open vacancy. If there are none, return [].${seasonalOn() ? `
It's Christmas hiring season: include temporary, seasonal and Christmas roles of these kinds too (Christmas markets, festive pop-ups, seasonal café or hotel staff), and put "Seasonal" or "Temporary" in their type.` : ''}
List at most 25 roles, most coffee-focused first.
Reply with ONLY a JSON array, no other text. Each item:
{"title": "...", "location": "town or county", "salary": "only if stated, else empty", "type": "Full time / Part time / Contract / Seasonal / Temporary, or empty", "applyUrl": "the most specific link from the LINKS list for this role, or the careers page", "summary": "one or two plain sentences about the role, in your own words"}

LINKS:
${links.map(l => `- ${l.text} → ${l.href}`).join('\n').slice(0, 25000)}

PAGE:
${text}`;

  const data = await callClaude(prompt, env, 6000);
  const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const roles = parseJsonArray(reply);
  if (!roles.length) return [];

  const allowed = new Set([pageUrl, ...links.map(l => l.href)]);
  return roles.slice(0, 25).map(r => {
    const title = String(r.title || '').trim().slice(0, 120);
    // Only accept links that really appeared on the page — never one the AI made up.
    const link = cleanUrl(r.applyUrl);
    return {
      title,
      location: String(r.location || '').trim().slice(0, 80) || 'Ireland',
      salary: String(r.salary || '').trim().slice(0, 60),
      type: String(r.type || '').trim().slice(0, 30),
      applyUrl: link && allowed.has(link) ? link : pageUrl,
      summary: String(r.summary || '').trim().slice(0, 400),
    };
  }).filter(r => r.title);
}

const normName = s => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]/g, '');
const TITLE_FILLER = /\b(full[- ]?time|part[- ]?time|ft|pt|permanent|contract|term[- ]?time|immediate start|urgent(ly)?|wanted|required|hiring|vacancy|job|role|position|[0-9]+\/[0-9]+)\b/g;
function coreTitle(t) {
  let x = String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ');
  x = x.split(/\s[-–—|@]\s|,/)[0];          // drop "- Smithfield", "| Dublin", ", Cork"
  return x.replace(TITLE_FILLER, ' ').replace(/[^a-z0-9]/g, '');
}
const placeKey = l => String(l || '').toLowerCase().split(/[,(/]/)[0].replace(/[^a-z0-9]/g, '');
function urlKey(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return ''; }
}
function hostKey(u) {
  try {
    const x = new URL(u); const h = x.hostname.replace(/^www\./, '').toLowerCase();
    // Shared hiring platforms: the employer is the first part of the path (or the subdomain).
    if (/(workable|greenhouse|lever|bamboohr|smartrecruiters|personio|teamtailor|recruitee|jobs\.ashbyhq)\./.test(h)) {
      return h + '/' + (x.pathname.split('/').filter(Boolean)[0] || '');
    }
    return h;
  } catch { return ''; }
}
// Words that change what the job is: level (head, senior, assistant…) or kind
// of role (pastry, kitchen, front of house…). Compared as a sorted set.
const RANK_WORDS = ['head','senior','snr','sr','lead','principal','junior','jnr','jr','trainee','apprentice','graduate','intern',
  'assistant','asst','deputy','sous','supervisor','manager','mgr','management','general','area','regional','team','shift','duty',
  'commis','partie','executive','pastry','kitchen','front','floor','store','shop','bar','coffee','roaster','roastery','roasting','production','packing','dispatch','training','trainer','coordinator','chef','barista','baker','porter'];
function rankWords(t) {
  const x = String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/\s[-–—|@]\s|,/)[0];
  return [...new Set(x.split(/[^a-z]+/).filter(w => RANK_WORDS.includes(w)))].sort().join(' ');
}
function sameEmployer(listing, emp) {
  const d = listing.data || {};
  const a = normName(d.venue), b = normName(emp.name);
  if (a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))))) return true;
  const eh = hostKey(emp.url);
  return !!eh && [d.sourceUrl, d.applyUrl].some(u => u && hostKey(u) === eh);
}
// True when this role (or the employer as a whole, via a "they're hiring" listing)
// is already on the board — live or hidden by Ger.
function alreadyOnBoard(role, emp, listings) {
  const ct = coreTitle(role.title);
  const ru = role.applyUrl && role.applyUrl !== cleanUrl(emp.url) ? urlKey(role.applyUrl) : '';
  return listings.some(l => {
    if (l.kind !== 'job' || !l.data) return false;
    if (ru && urlKey(l.data.applyUrl) === ru) return true;
    if (!sameEmployer(l, emp)) return false;
    if (l.roundup) return true;
    if (isSeasonal(`${role.title} ${role.type}`) !== isSeasonal(`${l.data.title} ${l.data.type}`)) return false;
    const lt = coreTitle(l.data.title);
    if (!ct || !lt) return false;
    if (ct === lt) return true;
    // "Barista" vs "Head Barista" are different jobs: any difference in level or
    // kind-of-role words means a separate role, only other extra words are ignored.
    if (rankWords(role.title) !== rankWords(l.data.title)) return false;
    return Math.min(ct.length, lt.length) >= 5 && (ct.includes(lt) || lt.includes(ct));
  });
}

async function saveDraftIfNew(role, emp, listings, state, env) {
  // Small wording changes between scans ("Kitchen Crew" vs "Kitchen Crew - Smithfield",
  // "Dublin" vs "Dublin, Smithfield") must not make an old job look new.
  const key = `${normName(emp.name)}|${coreTitle(role.title)}|${placeKey(role.location)}` + (isSeasonal(`${role.title} ${role.type}`) ? '|seasonal' : '');
  const seenKey = 'scan:seen:' + await hashText(key);
  if (await env.FDC_STORE.get(seenKey)) return null;
  // Jobs offered before this change were remembered by their exact wording.
  const oldKey = `${emp.name}|${role.title}|${role.location}`.toLowerCase().replace(/\s+/g, ' ');
  if (await env.FDC_STORE.get('scan:seen:' + await hashText(oldKey))) return null;
  if (alreadyOnBoard(role, emp, listings)) {
    // Shown in small print in the email so Ger can spot a real new job that got skipped.
    state.skipped = state.skipped || [];
    const line = `${emp.name.replace(/\s*\([^)]*\)/g, '')}: ${role.title}${role.location ? ' (' + role.location + ')' : ''}`;
    if (!state.skipped.includes(line)) state.skipped.push(line);
    return null;
  }

  const id = crypto.randomUUID();
  const draft = { id, token: randomToken(), week: state.week, allToken: state.allToken, employer: emp.name, sourceUrl: cleanUrl(emp.url), ...role, createdAt: Date.now() };
  await env.FDC_STORE.put(`scan:draft:${id}`, JSON.stringify(draft), { expirationTtl: 60 * 60 * 24 * 14 });
  await env.FDC_STORE.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 45 });
  return id;
}

// Uses Claude with web search to (1) find careers pages for employers
// on the list that don't have one yet and (2) add up to 10 new ones.
async function discoverEmployers(env) {
  const employers = await getScanEmployers(env);
  // Up to 10 unconfirmed employers per week, each tried at most 3 times.
  const toCheck = employers.filter(e => !e.url && !e.formOnly && (e.tries || 0) < 3).slice(0, 10);
  toCheck.forEach(e => { e.tries = (e.tries || 0) + 1; });
  const missing = toCheck.map(e => e.name);
  const known = employers.map(e => e.name);
  const prompt = `You are building a list of employers for a coffee and hospitality jobs board in Ireland.
Task 1: find the employer's OWN careers or jobs page for each of these: ${missing.length ? missing.join('; ') : '(none)'}. It must be a page that lists individual open roles (on their own site or their own hiring platform). If they only have a general "send us your CV" form, include them with "formOnly": true.
Task 2: find up to 10 MORE employers based in Ireland that hire baristas, café, coffee or hospitality staff AND have their own careers page: specialty coffee roasters, café groups, bakery-café chains, hotel groups, contract caterers. Do not repeat any of these: ${known.join('; ')}.
Only use the employer's own website or their own hiring page. Hiring platform pages are best (Workable, Recruitee, Greenhouse, Lever, BambooHR, SmartRecruiters, Personio, Teamtailor): if the careers page sends people to one, give that platform link. Never use Indeed, LinkedIn, Jobs.ie, IrishJobs, JobsIreland, Glassdoor or recruitment agencies.
When finished, reply with ONLY a JSON array, no other text: [{"name": "...", "type": "short description", "url": "https://...", "formOnly": false}], including Task 1 results under their exact names above. Leave out any employer whose careers page you could not find.`;

  const found = await callClaudeWithSearch(prompt, env);
  const start = found.indexOf('['), end = found.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let items; try { items = JSON.parse(found.slice(start, end + 1)); } catch { return []; }

  const added = [];
  const byName = new Map(employers.map(e => [e.name.toLowerCase(), e]));
  const hosts = new Set(employers.filter(e => e.url).map(e => { try { return new URL(e.url).hostname; } catch { return ''; } }));
  for (const it of (Array.isArray(items) ? items : []).slice(0, 25)) {
    const url = cleanUrl(it && it.url);
    const name = String((it && it.name) || '').trim().slice(0, 80);
    if (!name) continue;
    const existing = byName.get(name.toLowerCase());
    if (existing && !existing.url && it.formOnly === true) {
      existing.formOnly = true;              // no job list to scan — watch for them in invites instead
      added.push(`${name} (no job list on their site, so watching for them in invites)`);
      continue;
    }
    if (!url || it.formOnly === true) continue;
    const host = new URL(url).hostname;
    if (BLOCKED_JOB_SITES.test(host)) continue;
    if (existing) {
      if (!existing.url) { existing.url = url; added.push(`${name} (careers page found)`); hosts.add(host); }
      continue;
    }
    if (hosts.has(host) || added.length >= 14) continue;
    const emp = { name, type: String(it.type || '').slice(0, 60), url };
    employers.push(emp); byName.set(name.toLowerCase(), emp); hosts.add(host);
    added.push(name);
  }
  await env.FDC_STORE.put('scan:employers', JSON.stringify(employers));
  return added;
}

// Claude with web search. Keeps each run small (few searches) so it stays
// inside the account's per-minute limits; if a limit or a busy server is hit,
// waits a minute and tries once more. Errors carry a short, readable reason.
async function callClaudeWithSearch(prompt, env, maxUses = 6) {
  let messages = [{ role: 'user', content: prompt }];
  let text = '';
  let retried = false;
  for (let round = 0; round < 3; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 4000, messages,
        // No location setting: Ireland isn't a supported country for it, and the prompts already ask for Irish employers.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      }),
    });
    const raw = await res.text();
    let data = null; try { data = JSON.parse(raw); } catch {}
    if (!res.ok || !data || !data.content) {
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && !retried) {
        retried = true; round--;
        await new Promise(r => setTimeout(r, 65000));
        continue;
      }
      const why = data && data.error ? `${data.error.type}: ${data.error.message}` : raw.slice(0, 120);
      throw new Error(`AI search failed (${res.status} ${why})`.slice(0, 220));
    }
    text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (data.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: data.content }];
  }
  return text;
}

// How coffee-focused a job title is — used to pick each employer's top three.
function coffeeScore(title) {
  const t = String(title || '').toLowerCase();
  if (/barista|coffee|espresso|roast|green buyer|q grader/.test(t)) return 4;
  if (/production|packing|packer/.test(t)) return 3;
  if (/caf[eé]|deli|bakery|baker|pastry|counter|food ?hall/.test(t)) return 3;
  if (/chef|cook|kitchen|food|f&b|beverage|waiter|waitress|server|bar|host|restaurant|breakfast/.test(t)) return 2;
  return 1;
}

const PER_EMPLOYER = 3;

// Christmas season: temporary, seasonal and Christmas jobs are looked for too,
// up to and including this date (Dublin time). Ger asked 13/11/26: "until January".
const SEASONAL_UNTIL = '2027-01-06';
const seasonalOn = (now = new Date()) => dublinNow(now).date <= SEASONAL_UNTIL;
const isSeasonal = s => /\b(christmas|xmas|festive|seasonal|temporary|temp|holiday cover)\b/i.test(String(s || ''));

// Builds the Monday email: at most three roles per employer (most coffee-
// focused first), a one-post "They're hiring" roundup for any employer with
// more, then employers to invite. Sent with proper buttons.
async function sendScanEmail(state, env) {
  const base = env.WORKER_URL || 'https://cv-review.firstdraftcoffee.workers.dev';
  const drafts = [];
  for (const id of state.drafts) {
    const raw = await env.FDC_STORE.get(`scan:draft:${id}`);
    if (raw) drafts.push(JSON.parse(raw));
  }
  const groups = new Map();
  for (const d of drafts) { if (!groups.has(d.employer)) groups.set(d.employer, []); groups.get(d.employer).push(d); }
  const shown = [], roundups = [];
  for (const [employer, list] of groups) {
    list.sort((a, b) => coffeeScore(b.title) - coffeeScore(a.title));
    shown.push(...list.slice(0, PER_EMPLOYER));
    if (list.length > PER_EMPLOYER) {
      const top = [...new Set(list.map(x => x.title))].slice(0, 4);
      const places = [...new Set(list.map(x => x.location).filter(Boolean))];
      const r = { id: crypto.randomUUID(), token: randomToken(), week: state.week, employer, count: list.length, titles: top,
        locations: places.length > 3 ? `${places.slice(0, 3).join(', ')} and more` : places.join(', '),
        sourceUrl: list[0].sourceUrl || list[0].applyUrl };
      await env.FDC_STORE.put(`scan:roundup:${r.id}`, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 * 14 });
      roundups.push(r);
    }
  }
  state.shown = shown.map(d => d.id);
  state.roundups = roundups.map(r => r.id);

  const leads = [];
  for (const id of (state.leads || [])) {
    const raw = await env.FDC_STORE.get(`scan:lead:${id}`);
    if (raw) leads.push(JSON.parse(raw));
  }

  const [y, m, d] = state.week.split('-');
  const date = `${d}/${m}/${y.slice(2)}`;
  const employers = groups.size;
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const btn = (href, label, ghost) => `<a href="${esc(href)}" style="display:inline-block;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;text-decoration:none;${ghost ? 'border:1px solid #b4532a;color:#b4532a;background:#fff;' : 'background:#b4532a;color:#fff;'}">${esc(label)}</a>`;
  const card = inner => `<div style="background:#fff;border:1px solid #e3d9cb;border-radius:12px;padding:14px 16px;margin:10px 0;">${inner}</div>`;
  const h2 = (t, sub) => `<h2 style="font-size:18px;margin:28px 0 4px;">${esc(t)}</h2>${sub ? `<p style="margin:0 0 8px;color:#6b6157;font-size:14px;">${esc(sub)}</p>` : ''}`;

  const html = [];
  const text = [];
  html.push(`<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f5efe6;padding:20px 14px;color:#161310;"><div style="max-width:560px;margin:0 auto;">
<p style="margin:0;color:#b4532a;font-size:12px;letter-spacing:.08em;text-transform:uppercase;">Dublin Coffee Jobs · ${esc(date)}</p>
<h1 style="font-size:22px;margin:6px 0 4px;">${shown.length ? `${shown.length} job${shown.length === 1 ? '' : 's'} from ${employers} employer${employers === 1 ? '' : 's'}` : 'No new jobs this time'}${leads.length ? ` · ${leads.length} to invite` : ''}</h1>
<p style="margin:0;color:#6b6157;font-size:14px;">Anything you post goes on the board straight away. Its Instagram and Facebook post goes out within a few hours, one an hour.</p>`);
  text.push(`Dublin Coffee Jobs · ${date}`, '');
  const n = state.numbers;
  if (n) {
    const cell = (v, l) => `<td style="padding:10px 8px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#b4532a;">${esc(v)}</div><div style="font-size:12px;color:#6b6157;">${esc(l)}</div></td>`;
    html.push(`<div style="background:#fff;border:1px solid #e3d9cb;border-radius:12px;margin:16px 0 0;"><p style="margin:10px 12px 0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b6157;">Last 7 days</p><table role="presentation" style="width:100%;border-collapse:collapse;"><tr>${cell(n.newListings, 'new listings')}${cell(n.applications, 'applications sent')}${cell(n.applyClicks, 'clicks to employer sites')}</tr><tr>${cell(n.liveListings, 'live on the board')}${cell(n.views, 'listing views')}<td></td></tr></table></div>`);
    text.push(`Last 7 days: ${n.newListings} new listings · ${n.applications} applications sent · ${n.applyClicks} clicks to employer sites · ${n.liveListings} live · ${n.views} listing views`, '');
  }

  if (shown.length) {
    html.push(h2('Jobs to post', `Up to ${PER_EMPLOYER} per employer, most coffee-focused first.`));
    text.push('JOBS TO POST', '');
    for (const [employer, list] of groups) {
      const top = list.slice(0, PER_EMPLOYER);
      html.push(`<p style="margin:18px 0 0;font-weight:700;">${esc(employer)}${list.length > PER_EMPLOYER ? ` <span style="font-weight:400;color:#6b6157;">· ${list.length} roles found</span>` : ''}</p>`);
      for (const r of top) {
        const meta = [r.location, r.salary, r.type].filter(Boolean).join(' · ');
        html.push(card(`<strong>${esc(r.title)}</strong><div style="color:#6b6157;font-size:14px;margin:2px 0 10px;">${esc(meta)}</div>${btn(`${base}/scan/review?id=${r.id}&t=${r.token}`, 'Check & post')}`));
        text.push(`${r.title} — ${employer}${meta ? ' · ' + meta : ''}`, `Check & post: ${base}/scan/review?id=${r.id}&t=${r.token}`, '');
      }
    }
    html.push(`<div style="margin:16px 0;">${btn(`${base}/scan/review-all?w=${state.week}&t=${state.allToken}`, `Post all ${shown.length}`)}</div>`);
    text.push(`Post all ${shown.length}: ${base}/scan/review-all?w=${state.week}&t=${state.allToken}`, '');
  }

  if (roundups.length) {
    html.push(h2('Big employers: post as one', 'Instead of lots of separate posts, put up a single "they\'re hiring" listing that links to their careers page.'));
    text.push('BIG EMPLOYERS — POST AS ONE', '');
    for (const r of roundups) {
      html.push(card(`<strong>${esc(r.employer)} is hiring</strong><div style="color:#6b6157;font-size:14px;margin:2px 0 10px;">${esc(r.count)} roles${r.locations ? ' · ' + esc(r.locations) : ''}<br>including ${esc(r.titles.join(', '))}</div>${btn(`${base}/scan/roundup?id=${r.id}&t=${r.token}`, 'Post as one listing', true)}`));
      text.push(`${r.employer} is hiring — ${r.count} roles`, `Post as one listing: ${base}/scan/roundup?id=${r.id}&t=${r.token}`, '');
    }
  }

  if (leads.length) {
    html.push(h2(`Employers to invite (${leads.length})`, `Hiring elsewhere but not on Dublin Coffee Jobs yet. They get one short email offering a free listing; if they tap yes, their job goes live by itself. Replies go to ${env.INVITE_REPLY_TO || env.ALERT_EMAIL_TO}.`));
    text.push('EMPLOYERS TO INVITE', '');
    for (const l of leads) {
      html.push(card(`<strong>${esc(l.employer)}</strong> · ${l.noAd ? 'no current ad seen, general invite' : esc(l.role)}${l.location ? ', ' + esc(l.location) : ''}<div style="color:#6b6157;font-size:14px;margin:2px 0 10px;">${esc(l.email)}</div>${btn(`${base}/scan/invite?id=${l.id}&t=${l.token}`, 'Send invite', true)}`));
      text.push(`${l.employer} — ${l.role}${l.location ? ', ' + l.location : ''} (${l.email})`, `Send invite: ${base}/scan/invite?id=${l.id}&t=${l.token}`, '');
    }
    html.push(`<div style="margin:16px 0;">${btn(`${base}/scan/invite-all?w=${state.week}&t=${state.allToken}`, `Invite all ${leads.length}`)}</div>`);
    text.push(`Invite all ${leads.length}: ${base}/scan/invite-all?w=${state.week}&t=${state.allToken}`, '');
  }

  const extras = [];
  if (state.addedEmployers.length) extras.push(`Added to the scan: ${state.addedEmployers.join(', ')}.`);
  extras.push(...state.notes);
  const skipped = state.skipped || [];
  if (skipped.length) {
    const showS = skipped.slice(0, 30);
    html.push(`<div style="margin-top:24px;color:#6b6157;font-size:13px;"><p style="margin:0 0 4px;font-weight:600;">Left out: already on the board (${skipped.length})</p><p style="margin:0 0 6px;">Worth a glance: if one of these is really a new job, tell Claude so the check can be fixed.</p>${showS.map(x => `<div style="margin:2px 0;">${esc(x)}</div>`).join('')}${skipped.length > showS.length ? `<div style="margin:2px 0;">and ${skipped.length - showS.length} more</div>` : ''}</div>`);
    text.push(`LEFT OUT — ALREADY ON THE BOARD (${skipped.length})`, ...showS, '');
  }
  if (extras.length) { html.push(`<div style="margin-top:24px;color:#6b6157;font-size:13px;">${extras.map(e => `<p style="margin:6px 0;">${esc(e)}</p>`).join('')}</div>`); text.push(...extras, ''); }
  html.push(`<p style="margin-top:24px;color:#6b6157;font-size:12px;">Links work for 14 days. Nothing goes up unless you post it.</p></div></div>`);
  text.push('Links work for 14 days.');

  const subject = shown.length || leads.length
    ? `${shown.length} jobs from ${employers} employer${employers === 1 ? '' : 's'}${leads.length ? `, ${leads.length} to invite` : ''} — ${date}`
    : `Jobs scan — nothing new (${date})`;
  await sendEmailHtml(env, env.ALERT_EMAIL_TO, subject, text.join('\n'), html.join('\n'));
}

async function sendEmailHtml(env, to, subject, text, html, replyTo) {
  const payload = { from: 'Dublin Coffee Jobs <alerts@firstdraftcoffee.net>', to: [to], subject, text, html };
  if (replyTo) payload.reply_to = replyTo;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('Resend HTML send FAILED:', res.status, await res.text(), 'to:', to);
  } catch (e) { console.error('Resend HTML send threw:', String(e)); }
}

async function publishRoundup(r, env) {
  const id = crypto.randomUUID();
  const ttl = 14 * 24 * 60 * 60;
  const roundupLine = `${r.count} roles${r.locations ? ' across ' + r.locations : ''}, including ${r.titles.join(', ')}`;
  const record = {
    id, kind: 'job', tier: 'standard', status: 'published', createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000, flagged: false, spotted: true, roundup: true,
    data: {
      title: `${r.employer} is hiring`, venue: r.employer, location: r.locations || 'Ireland',
      salary: '', payOnSite: true, type: `${r.count} roles`, roundupLine,
      desc: `${roundupLine}. See every role and apply on their careers page.`,
      applyUrl: r.sourceUrl, sourceUrl: r.sourceUrl, skipScoring: true,
    },
  };
  await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
  await env.FDC_STORE.delete(`scan:roundup:${r.id}`);
  await queueSocial(record, env);
  return record;
}

async function publishDraft(draft, env, ctx) {
  const id = crypto.randomUUID();
  const ttl = 14 * 24 * 60 * 60;
  const record = {
    id, kind: 'job', tier: 'standard', status: 'published', createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000, flagged: false, spotted: true,
    data: {
      title: draft.title, venue: draft.employer, location: draft.location,
      salary: draft.salary || '', payOnSite: !draft.salary, type: draft.type || '',
      desc: draft.summary || '',   // the board shows a "Spotted on their careers page" note itself
      applyUrl: draft.applyUrl, sourceUrl: draft.sourceUrl || draft.applyUrl, skipScoring: true,
    },
  };
  await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
  await env.FDC_STORE.delete(`scan:draft:${draft.id}`);
  await queueSocial(record, env);
  return record;
}

function scanPage(title, body) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f5efe6;color:#161310;margin:0;padding:24px 16px}main{max-width:560px;margin:0 auto}
.card{background:#fff;border:1px solid #e3d9cb;border-radius:12px;padding:14px 16px;margin:10px 0}h1{font-size:1.4rem}.meta{color:#6b6157;font-size:.9rem}
button{background:#b4532a;color:#fff;border:0;border-radius:999px;padding:14px 22px;font-size:1rem;width:100%;margin-top:14px;cursor:pointer}a{color:#b4532a}</style></head>
<body><main>${body(esc)}</main></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function draftCard(esc, d) {
  return `<div class="card"><strong>${esc(d.title)}</strong> — ${esc(d.employer)}<div class="meta">${esc([d.location, d.salary, d.type].filter(Boolean).join(' · '))}</div>${d.summary ? `<p>${esc(d.summary)}</p>` : ''}<div class="meta">Applicants go to: <a href="${esc(d.applyUrl)}" target="_blank" rel="noopener nofollow">${esc(d.applyUrl)}</a></div></div>`;
}

// Routes for the approve links. Returns null when the path isn't one of these.
async function handleScanRoute(path, request, url, env, ctx) {
  const site = env.SITE_URL || 'https://dublincoffeejobs.com';
  const loadDraft = async (id, t) => {
    if (!id || !t) return null;
    const raw = await env.FDC_STORE.get(`scan:draft:${id}`);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d.token === t ? d : null;
  };
  const loadWeek = async (w, t) => {
    const st = w ? await loadScanState(env, w) : null;
    if (!st || st.allToken !== t) return null;
    const out = [];
    for (const id of (st.shown || st.drafts)) { const r = await env.FDC_STORE.get(`scan:draft:${id}`); if (r) out.push(JSON.parse(r)); }
    return out;
  };
  const gone = () => scanPage('Already done', () => `<h1>Nothing to post here</h1><p>This one has already been posted, or the link is more than 14 days old.</p><p><a href="${site}/job-board.html">Open the job board</a></p>`);

  if (path === '/scan/review' && request.method === 'GET') {
    const d = await loadDraft(url.searchParams.get('id'), url.searchParams.get('t'));
    if (!d) return gone();
    return scanPage('Post this job?', esc => `<h1>Post this job?</h1>${draftCard(esc, d)}
<form method="POST" action="/scan/approve"><input type="hidden" name="id" value="${esc(d.id)}"><input type="hidden" name="t" value="${esc(d.token)}"><button type="submit">Post it — free, goes out on Instagram & Facebook</button></form>`);
  }
  if (path === '/scan/approve' && request.method === 'POST') {
    const form = await request.formData();
    const d = await loadDraft(form.get('id'), form.get('t'));
    if (!d) return gone();
    const rec = await publishDraft(d, env, ctx);
    return scanPage('Posted', esc => `<h1>Posted ✓</h1><p><strong>${esc(d.title)}</strong> at ${esc(d.employer)} is live on the board. Its Instagram and Facebook post goes out within the hour.</p><p><a href="${site}/job-board.html?id=${esc(rec.id)}">See it on the board</a></p>`);
  }
  const loadRoundup = async (id, t) => {
    if (!id || !t) return null;
    const raw = await env.FDC_STORE.get(`scan:roundup:${id}`);
    if (!raw) return null;
    const r = JSON.parse(raw);
    return r.token === t ? r : null;
  };
  if (path === '/scan/roundup' && request.method === 'GET') {
    const r = await loadRoundup(url.searchParams.get('id'), url.searchParams.get('t'));
    if (!r) return gone();
    return scanPage('Post as one listing?', esc => `<h1>Post "${esc(r.employer)} is hiring"?</h1>
<div class="card"><strong>${esc(r.employer)} is hiring</strong><div class="meta">${esc(r.count)} roles${r.locations ? ' · ' + esc(r.locations) : ''}</div><p>Including ${esc(r.titles.join(', '))}.</p><div class="meta">Applicants go to: <a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener nofollow">${esc(r.sourceUrl)}</a></div></div>
<form method="POST" action="/scan/roundup-post"><input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="t" value="${esc(r.token)}"><button type="submit">Post it as one listing</button></form>`);
  }
  if (path === '/scan/roundup-post' && request.method === 'POST') {
    const form = await request.formData();
    const r = await loadRoundup(form.get('id'), form.get('t'));
    if (!r) return gone();
    const rec = await publishRoundup(r, env);
    return scanPage('Posted', esc => `<h1>Posted ✓</h1><p><strong>${esc(r.employer)} is hiring</strong> is live on the board. Its Instagram and Facebook post goes out within the hour.</p><p><a href="${site}/job-board.html?id=${esc(rec.id)}">See it on the board</a></p>`);
  }
  if (path === '/scan/review-all' && request.method === 'GET') {
    const w = url.searchParams.get('w'), t = url.searchParams.get('t');
    const list = await loadWeek(w, t);
    if (!list || !list.length) return gone();
    return scanPage('Post all?', esc => `<h1>Post all ${list.length}?</h1>${list.map(d => draftCard(esc, d)).join('')}
<form method="POST" action="/scan/approve-all"><input type="hidden" name="w" value="${esc(w)}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">Post all ${list.length}</button></form>`);
  }
  if (path === '/scan/approve-all' && request.method === 'POST') {
    const form = await request.formData();
    const list = await loadWeek(form.get('w'), form.get('t'));
    if (!list || !list.length) return gone();
    for (const d of list) await publishDraft(d, env, ctx);
    return scanPage('Posted', () => `<h1>Posted ✓</h1><p>${list.length} jobs are live on the board. Their Instagram and Facebook posts go out one an hour (daytime only) so your followers' feeds don't get flooded.</p><p><a href="${site}/job-board.html">Open the job board</a></p>`);
  }
  return handleInviteRoute(path, request, url, env, ctx);
}

// ═══════════════════════════════════════════════════════════════════
// EMPLOYER INVITES — employers hiring on Indeed etc. but not on DCJ.
// We only use job sites to learn WHO is hiring. Nothing is copied from
// them: the employer gets one polite email (only after Ger taps "Send
// invite"), and their job only goes up if THEY tap yes and confirm the
// details themselves. Every email has a "never email me again" link.
// KV: scan:lead:<id> (14 days), invite:<id> (30 days),
// invite:sent:<email> (90 days, no repeat invites), invite:optout:<email
// or @domain> (forever).
// ═══════════════════════════════════════════════════════════════════

const GENERIC_INBOX = /^(info|hello|hi|jobs|job|careers|career|recruitment|recruit|recruiting|hr|people|work|team|contact|enquiries|enquiry|hiring|admin|office|cafe|coffee|shop|bookings|reservations|manager|management|general|mail)([.\-_]?[a-z0-9]*)?$/i;
const MAX_LEADS = 20;
// Employers Ger has spotted hiring (one-off posts, no jobs page). Offered once
// in the next email as an invite; checked against opt-outs and repeats as usual.
const MANUAL_INVITE_LEADS = [
  { employer: 'Cloud Picker Coffee', role: 'Production Assistant / Barista', location: 'Dublin',
    email: 'hello@cloudpickercoffee.ie', website: 'https://cloudpickercoffee.ie' },   // seen 03/11/26, blog post dated 07/09/26
  { employer: 'Guji Coffee Bar', role: 'Barista', location: 'Limerick',
    email: 'jobs@guji.ie', website: 'https://guji.ie' },   // seen 03/11/26, jobs page last updated 2022
  { employer: 'Roasted Notes', role: 'Café Assistant Manager', location: 'Swords Pavilions, Co. Dublin',
    email: 'hradmin@ksg.ie', website: 'https://www.roastednotes.ie' },   // seen 09/11/26, careers page has no date
  { employer: 'Mister Magpie Coffee', role: 'Head Barista', location: 'Dublin',
    email: 'info@mistermagpiecoffee.com', website: 'https://mistermagpiecoffee.com' },   // email from Ger 13/11/26; always hiring via job sites
  { employer: 'The Art of Coffee', role: 'Barista', location: 'Dublin',
    email: 'hello@theartofcoffee.ie', website: 'https://theartofcoffee.ie' },   // email from Ger 13/11/26; always hiring via job sites
  { employer: 'Silverskin Coffee Roasters', role: 'Coffee Professional', location: 'Dublin 10',
    email: 'info@silverskincoffee.ie', website: 'https://silverskincoffee.ie' },   // email + role from Ger 13/11/26
  { employer: 'Eclective Hospitality', role: 'Barista', location: 'Dublin',
    email: 'recruitment@eclective.ie', website: 'https://eclective.ie/careers', noAd: true },   // 13/11/26: careers page has no job list, applications by email; only ads seen were from 2025, so general wording
  { employer: 'Butlers Chocolate Café', role: 'Café Manager & Supervisor', location: 'Carrickmines',
    email: 'careers@butlers.ie', website: 'https://www.butlerschocolates.com/our-careers' },   // seen by Ger 14/11/26; email from their careers page
  { employer: 'Southbank Café', role: 'Front of House / Barista', location: "Harold's Cross",
    email: 'hello@southbankcafe.ie', website: 'https://southbankcafe.ie' },   // job seen by Ger 14/11/26; email from Ger
];

function validInviteEmail(e) {
  const email = String(e || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email) || email.length > 120) return '';
  // Only shared business inboxes — never a named person's address.
  return GENERIC_INBOX.test(email.split('@')[0]) ? email : '';
}

async function isOptedOut(email, env) {
  const domain = '@' + email.split('@')[1];
  return !!(await env.FDC_STORE.get(`invite:optout:${email}`)) ||
    (!/@(gmail|yahoo|hotmail|outlook|icloud|live|eircom)\./.test(domain) && !!(await env.FDC_STORE.get(`invite:optout:${domain}`)));
}

async function findInviteLeads(env, listings, state) {
  const employers = await getScanEmployers(env);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const onBoard = new Set(listings.filter(l => l.kind === 'job').map(l => norm(l.data && l.data.venue)));
  const scanned = employers.filter(e => e.url).map(e => e.name);
  const watch = employers.filter(e => !e.url || e.alsoWatch).map(e => e.name);
  const prompt = `You are helping Dublin Coffee Jobs, a free Irish coffee and hospitality jobs board, invite employers to list their vacancies.
Find as many as you can, up to ${MAX_LEADS}, employers in Ireland that are hiring RIGHT NOW (ads from the last 3 weeks) for coffee, café, bakery, restaurant, bar or hotel front-line roles — barista, café staff, supervisor or manager, coffee roaster, roastery or production assistant, chef, waiting staff, bartender and similar.${seasonalOn() ? ' Temporary, seasonal and Christmas roles count too (Christmas markets, festive pop-ups, seasonal café staff).' : ''} Favour independent cafés, coffee roasters, bakeries and small groups.
You may use job sites such as Indeed, IrishJobs, Jobs.ie or LinkedIn ONLY to see who is hiring and for what role. Do not copy anything else from them.
Work efficiently: use job-site searches to collect several hiring employers at once, then find each one's GENERAL contact email published on the employer's OWN website (e.g. info@, hello@, jobs@, careers@). Never use a named person's email address, and never guess an address. Skip the employer if you can't find one.
Check these first, and include any that are hiring now: ${watch.join('; ')}.
Skip recruitment agencies and these employers: ${scanned.join('; ')}.
Reply with ONLY a JSON array, no other text: [{"employer": "...", "role": "job title", "location": "town or county", "email": "...", "website": "https://their own site"}]`;
  let found = [];
  try {
    found = parseJsonArray(await callClaudeWithSearch(prompt, env, 15));
  } catch (e) {
    state.notes.push(`Couldn't look for employers to invite this time. Reason: ${String(e.message || e).slice(0, 220)}`);
  }
  const manual = [];
  for (const m of MANUAL_INVITE_LEADS) {
    const offered = `invite:offered:${m.email}`;
    if (await env.FDC_STORE.get(offered)) continue;
    await env.FDC_STORE.put(offered, '1', { expirationTtl: 60 * 60 * 24 * 30 });
    manual.push(m);
  }
  const items = [...manual, ...found];

  const ids = [], seen = new Set();
  for (const it of items) {
    if (ids.length >= MAX_LEADS) break;
    const email = validInviteEmail(it && it.email);
    const employer = String((it && it.employer) || '').trim().slice(0, 80);
    const role = String((it && it.role) || '').trim().slice(0, 80);
    if (!email || !employer || !role || seen.has(email)) continue;
    seen.add(email);
    if (onBoard.has(norm(employer))) continue;
    if (await isOptedOut(email, env)) continue;
    if (await env.FDC_STORE.get(`invite:sent:${email}`)) continue;
    let website = cleanUrl(it.website);
    if (website && BLOCKED_JOB_SITES.test(new URL(website).hostname)) website = '';
    const id = crypto.randomUUID();
    const lead = { id, token: randomToken(), week: state.week, employer, role,
      location: String(it.location || '').trim().slice(0, 60), email, website, ...(it.noAd ? { noAd: true } : {}) };
    await env.FDC_STORE.put(`scan:lead:${id}`, JSON.stringify(lead), { expirationTtl: 60 * 60 * 24 * 14 });
    ids.push(id);
  }
  return ids;
}

function inviteEmailText(lead, inv, env) {
  const base = env.WORKER_URL || 'https://cv-review.firstdraftcoffee.workers.dev';
  return `Hi ${lead.employer} team,

${lead.noAd ? `Next time you're hiring, we'd love to help.` : `We noticed you're hiring a ${lead.role}${lead.location ? ' in ' + lead.location : ''}.`} Dublin Coffee Jobs is Ireland's coffee and hospitality jobs community: 23,000 followers, 10 years running.

Listing is free until the new year. ${lead.noAd ? `Whenever you have a role to fill, tap below to add it. It takes about two minutes:` : `If you'd like your role on it, tap below. The details are already filled in, so it takes about a minute:`}
${base}/invite/yes?id=${inv.id}&t=${inv.token}

It goes live straight away and gets shared on our Instagram and Facebook. Applications come straight to you.

If not, no worries, you won't hear from us again about ${lead.noAd ? 'this' : 'this role'}.

Thanks!
Dublin Coffee Jobs · ${env.SITE_URL || 'https://dublincoffeejobs.com'}

Don't want any emails from us? ${base}/invite/stop?id=${inv.id}&t=${inv.token}`;
}

async function sendInvite(lead, env) {
  if (await isOptedOut(lead.email, env)) {
    await env.FDC_STORE.delete(`scan:lead:${lead.id}`);
    return 'they asked not to be emailed';
  }
  const prev = await env.FDC_STORE.get(`invite:sent:${lead.email}`);
  if (prev) {
    await env.FDC_STORE.delete(`scan:lead:${lead.id}`);
    const when = /^\d{13}$/.test(prev) ? new Date(parseInt(prev, 10)) : null;
    if (!when) return 'already invited recently';
    const t = dublinNow(when).date.split('-');
    return `already invited on ${t[2]}/${t[1]}/${t[0].slice(2)}`;
  }
  const inv = { id: crypto.randomUUID(), token: randomToken(), employer: lead.employer, role: lead.noAd ? '' : lead.role,
    location: lead.location, email: lead.email, website: lead.website, sentAt: Date.now() };
  await env.FDC_STORE.put(`invite:${inv.id}`, JSON.stringify(inv), { expirationTtl: 60 * 60 * 24 * 30 });
  await env.FDC_STORE.put(`invite:sent:${lead.email}`, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 90 });
  // Keeps the "don't email me again" link working for a year, after the invite itself expires.
  await env.FDC_STORE.put(`invite:stop:${inv.id}`, JSON.stringify({ token: inv.token, email: lead.email }), { expirationTtl: 60 * 60 * 24 * 365 });
  await env.FDC_STORE.delete(`scan:lead:${lead.id}`);
  await sendEmailTo(env, lead.email, lead.noAd ? 'Free job listings on Dublin Coffee Jobs' : `Your ${lead.role} vacancy: free listing on Dublin Coffee Jobs?`,
    inviteEmailText(lead, inv, env), env.INVITE_REPLY_TO || env.ALERT_EMAIL_TO);
  return 'sent';
}

function inviteForm(esc, inv, error, v) {
  v = v || {};
  const val = (k, d) => esc(v[k] != null ? v[k] : d);
  const types = ['Full time', 'Part time', 'Contract', 'Seasonal'];
  return `<h1>Your listing on Dublin Coffee Jobs</h1>
<p class="meta">Check the details, add a salary, and tap the button. It goes live straight away and is shared on Instagram and Facebook. Free until the new year.</p>
${error ? `<p style="color:#b4532a"><strong>${esc(error)}</strong></p>` : ''}
<form method="POST" action="/invite/publish" class="card">
<input type="hidden" name="id" value="${esc(inv.id)}"><input type="hidden" name="t" value="${esc(inv.token)}">
<label>Job title<input name="title" required maxlength="120" value="${val('title', inv.role)}"></label>
<label>Business name<input name="venue" required maxlength="80" value="${val('venue', inv.employer)}"></label>
<label>Location<input name="location" required maxlength="80" value="${val('location', inv.location)}"></label>
<label>Salary or hourly rate<input name="salary" required maxlength="60" placeholder="e.g. €14.50/hr or €32k–36k" value="${val('salary', '')}"></label>
<label>Job type<select name="type">${types.map(x => `<option${(v.type || 'Full time') === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
<label>About the role (optional)<textarea name="desc" rows="4" maxlength="1500">${val('desc', '')}</textarea></label>
<label>Applications go to (email)<input name="email" type="email" maxlength="120" value="${val('email', inv.email)}"></label>
<label>Or apply on your website (optional)<input name="applyUrl" maxlength="500" placeholder="https://" value="${val('applyUrl', '')}"></label>
<button type="submit">Put it live — free</button>
</form>
<style>label{display:block;margin:10px 0;font-size:.9rem;color:#6b6157}input,select,textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border:1px solid #e3d9cb;border-radius:8px;font:inherit;color:#161310;background:#fff}</style>`;
}

async function handleInviteRoute(path, request, url, env, ctx) {
  const site = env.SITE_URL || 'https://dublincoffeejobs.com';
  const loadLead = async (id, t) => {
    if (!id || !t) return null;
    const raw = await env.FDC_STORE.get(`scan:lead:${id}`);
    if (!raw) return null;
    const l = JSON.parse(raw);
    return l.token === t ? l : null;
  };
  const loadLeads = async (w, t) => {
    const st = w ? await loadScanState(env, w) : null;
    if (!st || st.allToken !== t) return null;
    const out = [];
    for (const id of (st.leads || [])) { const r = await env.FDC_STORE.get(`scan:lead:${id}`); if (r) out.push(JSON.parse(r)); }
    return out;
  };
  const loadInvite = async (id, t) => {
    if (!id || !t) return null;
    const raw = await env.FDC_STORE.get(`invite:${id}`);
    if (!raw) return null;
    const inv = JSON.parse(raw);
    return inv.token === t ? inv : null;
  };
  const sentAlready = () => scanPage('Already done', () => `<h1>Nothing to send here</h1><p>This invite has already been sent, or the link is more than 14 days old.</p>`);
  const leadCard = (esc, l) => `<div class="card"><strong>${esc(l.employer)}</strong> — ${esc(l.role)}<div class="meta">${esc([l.location, l.email].filter(Boolean).join(' · '))}</div>${l.website ? `<div class="meta"><a href="${esc(l.website)}" target="_blank" rel="noopener nofollow">${esc(l.website)}</a></div>` : ''}</div>`;

  // ── Ger's side ──
  if (path === '/scan/invite' && request.method === 'GET') {
    const l = await loadLead(url.searchParams.get('id'), url.searchParams.get('t'));
    if (!l) return sentAlready();
    const preview = inviteEmailText(l, { id: '…', token: '…' }, env);
    return scanPage('Send invite?', esc => `<h1>Send this invite?</h1>${leadCard(esc, l)}
<details class="card"><summary>See the email they'll get</summary><pre style="white-space:pre-wrap;font:inherit">${esc(preview)}</pre></details>
<form method="POST" action="/scan/invite-send"><input type="hidden" name="id" value="${esc(l.id)}"><input type="hidden" name="t" value="${esc(l.token)}"><button type="submit">Send invite</button></form>`);
  }
  if (path === '/scan/invite-send' && request.method === 'POST') {
    const form = await request.formData();
    const l = await loadLead(form.get('id'), form.get('t'));
    if (!l) return sentAlready();
    const result = await sendInvite(l, env);
    return scanPage('Sent', esc => result === 'sent'
      ? `<h1>Invite sent ✓</h1><p>${esc(l.employer)} has been invited. If they tap yes, their job goes live and you'll get the usual "Paste into the DCJ Group" email.</p>`
      : `<h1>Not sent</h1><p>${esc(l.employer)}: ${esc(result)}, so no second email went out.</p>`);
  }
  if (path === '/scan/invite-all' && request.method === 'GET') {
    const w = url.searchParams.get('w'), t = url.searchParams.get('t');
    const list = await loadLeads(w, t);
    if (!list || !list.length) return sentAlready();
    return scanPage('Invite all?', esc => `<h1>Invite all ${list.length}?</h1>${list.map(l => leadCard(esc, l)).join('')}
<form method="POST" action="/scan/invite-send-all"><input type="hidden" name="w" value="${esc(w)}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">Send all ${list.length} invites</button></form>`);
  }
  if (path === '/scan/invite-send-all' && request.method === 'POST') {
    const form = await request.formData();
    const list = await loadLeads(form.get('w'), form.get('t'));
    if (!list || !list.length) return sentAlready();
    const rows = [];
    for (const l of list) rows.push({ l, result: await sendInvite(l, env) });
    const n = rows.filter(r => r.result === 'sent').length;
    return scanPage('Sent', esc => `<h1>${n} of ${rows.length} invite${rows.length === 1 ? '' : 's'} sent ✓</h1>
${rows.map(r => `<div class="card"><strong>${esc(r.l.employer)}</strong><div class="meta">${r.result === 'sent' ? 'Sent ✓' : 'Not sent: ' + esc(r.result)}</div></div>`).join('')}
<p class="meta">Anyone who taps yes goes live by themselves. Nobody gets more than one invite every 90 days.</p>`);
  }

  // ── The employer's side ──
  const expired = () => scanPage('Link expired', () => `<h1>This link has expired</h1><p>No problem, you can post your job free on <a href="${site}/job-board.html">dublincoffeejobs.com</a>. It only takes a couple of minutes.</p>`);
  if (path === '/invite/yes' && request.method === 'GET') {
    const inv = await loadInvite(url.searchParams.get('id'), url.searchParams.get('t'));
    if (!inv) return expired();
    return scanPage('Your listing', esc => inviteForm(esc, inv));
  }
  if (path === '/invite/publish' && request.method === 'POST') {
    const form = await request.formData();
    const inv = await loadInvite(form.get('id'), form.get('t'));
    if (!inv) return expired();
    const f = k => String(form.get(k) || '').trim();
    const v = { title: f('title').slice(0, 120), venue: f('venue').slice(0, 80), location: f('location').slice(0, 80),
      salary: f('salary').slice(0, 60), type: f('type').slice(0, 30), desc: f('desc').slice(0, 1500),
      email: f('email').toLowerCase().slice(0, 120), applyUrl: f('applyUrl').slice(0, 500) };
    let error = '';
    if (!v.title || !v.venue || !v.location) error = 'Please fill in the job title, business name and location.';
    else if (!v.salary) error = 'Please add a salary or hourly rate. Listings with pay get far more applicants.';
    else if (v.email && !/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(v.email)) error = 'That email address doesn\'t look right.';
    else if (v.applyUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(v.applyUrl)) error = 'The website link should start with https://';
    else if (!v.email && !v.applyUrl) error = 'Please add an email or a website link so people can apply.';
    if (error) return scanPage('Your listing', esc => inviteForm(esc, inv, error, v));

    const id = crypto.randomUUID();
    const ttl = 14 * 24 * 60 * 60;
    const data = { title: v.title, venue: v.venue, location: v.location, salary: v.salary, type: v.type, desc: v.desc };
    if (v.email) data.email = v.email;
    if (v.applyUrl) data.applyUrl = v.applyUrl;
    const record = { id, kind: 'job', tier: 'standard', status: 'published', createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000, flagged: false, freeLaunch: true, invited: true, data };
    await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
    await env.FDC_STORE.delete(`invite:${inv.id}`);
    ctx.waitUntil(postToSocial(record, env));
    ctx.waitUntil(notifyGroupPost(record, env));
    ctx.waitUntil(sendListingConfirmation(record, env));
    return scanPage('Live', esc => `<h1>You're live ✓</h1><p><strong>${esc(v.title)}</strong> at ${esc(v.venue)} is on Dublin Coffee Jobs now and going out on Instagram and Facebook.</p><p><a href="${site}/job-board.html?id=${esc(id)}">See your listing</a></p><p class="meta">Got more roles? Post them free any time at <a href="${site}/job-board.html">dublincoffeejobs.com</a>.</p>`);
  }
  if (path === '/invite/stop' && request.method === 'GET') {
    const id = url.searchParams.get('id'), t = url.searchParams.get('t');
    let email = '';
    const stopRaw = id && t ? await env.FDC_STORE.get(`invite:stop:${id}`) : null;
    if (stopRaw) { const st = JSON.parse(stopRaw); if (st.token === t) email = st.email; }
    if (email) {
      await env.FDC_STORE.put(`invite:optout:${email}`, '1');
      const domain = '@' + email.split('@')[1];
      if (!/@(gmail|yahoo|hotmail|outlook|icloud|live|eircom)\./.test(domain)) await env.FDC_STORE.put(`invite:optout:${domain}`, '1');
      await env.FDC_STORE.delete(`invite:${id}`);
    }
    return scanPage('Unsubscribed', () => `<h1>Done</h1><p>You won't get any more emails from Dublin Coffee Jobs. Sorry for the bother.</p>`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// SOCIAL QUEUE — scanned jobs Ger approves go on the board at once, but
// their Instagram/Facebook posts (and the Group paste note) go out one
// per hour, 8am–9pm Dublin time, so "Post all" doesn't flood the feed.
// KV: socialq:<time>-<listingId> (30 days), social:lastQueuedPost.
// ═══════════════════════════════════════════════════════════════════
const SOCIAL_GAP_MS = 55 * 60 * 1000;

async function queueSocial(record, env) {
  await env.FDC_STORE.put(`socialq:${String(Date.now()).padStart(15, '0')}-${record.id}`, record.id, { expirationTtl: 60 * 60 * 24 * 30 });
}

async function runSocialQueue(env, ctx, now = new Date()) {
  const t = dublinNow(now);
  if (t.hour < 8 || t.hour >= 21) return;
  const last = parseInt((await env.FDC_STORE.get('social:lastQueuedPost')) || '0', 10);
  if (now.getTime() - last < SOCIAL_GAP_MS) return;
  const q = await env.FDC_STORE.list({ prefix: 'socialq:' });
  const keys = q.keys.map(k => k.name).sort();
  for (const key of keys) {
    const id = await env.FDC_STORE.get(key);
    await env.FDC_STORE.delete(key);
    const raw = id ? await env.FDC_STORE.get(`listing:${id}`) : null;
    if (!raw) continue;                       // removed or expired meanwhile — skip to the next
    const record = JSON.parse(raw);
    if (record.flagged) continue;
    await env.FDC_STORE.put('social:lastQueuedPost', String(now.getTime()));
    await postToSocial(record, env);
    await notifyGroupPost(record, env);
    return;                                   // one per run
  }
}

// ═══════════════════════════════════════════════════════════════════
// FILLED-ROLE CHECK — once a day, re-check scanned jobs. If the
// employer's job link is gone (404/410), or the job title has vanished
// from their careers page two days running, the listing comes down so
// nobody clicks through to a dead job. Site errors are ignored.
// KV: linkcheck:lastRun, linkcheck:miss:<listingId>.
// ═══════════════════════════════════════════════════════════════════
async function runSpottedLinkCheck(env, listings, now = Date.now()) {
  const last = parseInt((await env.FDC_STORE.get('linkcheck:lastRun')) || '0', 10);
  if (now - last < 23 * 60 * 60 * 1000) return;
  await env.FDC_STORE.put('linkcheck:lastRun', String(now));
  const spotted = listings.filter(l => l.spotted && !l.roundup && !l.flagged && l.data && l.data.applyUrl).slice(0, 20);
  const words = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 4);
  const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept': 'text/html' };
  const hidden = [];
  for (const l of spotted) {
    let gone = false;
    try {
      // 1) The job's own page has gone — confirmed by asking twice, the second time as a browser.
      if (l.data.applyUrl !== l.data.sourceUrl) {
        const r1 = await fetch(l.data.applyUrl, { headers: { 'User-Agent': 'DublinCoffeeJobsBot/1.0 (+https://dublincoffeejobs.com)', 'Accept': 'text/html' }, redirect: 'follow' });
        if (r1.status === 404 || r1.status === 410) {
          const r2 = await fetch(l.data.applyUrl, { headers: BROWSER, redirect: 'follow' });
          if (r2.status === 404 || r2.status === 410) gone = true;
        }
      } else {
        // 2) Only a general careers page to go on: check the job is still mentioned —
        //    but only when the page is properly readable, matching on the title's
        //    main words (titles get reworded), and only after 3 misses in a row.
        let html = await fetchPageHtml(l.data.applyUrl);
        let text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
        if (text.replace(/\s+/g, ' ').length < 2500) { const extra = await readBuilderData(l.data.applyUrl, html); text += ' ' + extra.text; }
        const pageWords = new Set(words(text));
        const titleWords = words(l.data.title);
        const readable = pageWords.size > 150;
        const found = !titleWords.length || titleWords.filter(w => pageWords.has(w)).length / titleWords.length >= 0.6;
        const missKey = `linkcheck:miss:${l.id}`;
        if (!readable || found) {
          await env.FDC_STORE.delete(missKey);
        } else {
          const misses = parseInt((await env.FDC_STORE.get(missKey)) || '0', 10) + 1;
          if (misses >= 3) gone = true;
          else await env.FDC_STORE.put(missKey, String(misses), { expirationTtl: 60 * 60 * 24 * 5 });
        }
      }
    } catch (e) { /* site down or slow — try again tomorrow */ }
    if (gone) {
      // Hidden, not deleted — can be brought back from the admin page or a report email's Restore link.
      l.flagged = true; l.autoHidden = true; l.flagReason = 'Job no longer on the employer’s site (automatic check)';
      await putListing(env, l);
      hidden.push(`${l.data.title} — ${l.data.venue}`);
    }
  }
  if (hidden.length) console.log('Hid filled roles:', hidden.join('; '));
}

// ═══════════════════════════════════════════════════════════════════
// HIRING PLATFORMS — public job feeds. Each returns a tidy list of
// { title, location, type, link, about } for the AI to filter.
// ═══════════════════════════════════════════════════════════════════
const ATS_PATTERNS = [
  ['recruitee', /https?:\/\/([a-z0-9-]+)\.recruitee\.com/i],
  ['workable', /https?:\/\/apply\.workable\.com\/api\/v\d\/widget\/accounts\/([a-z0-9-]+)/i],
  ['workable', /https?:\/\/apply\.workable\.com\/([a-z0-9-]+)/i],
  ['workable', /https?:\/\/([a-z0-9-]+)\.workable\.com/i],
  ['greenhouse', /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i],
  ['lever', /https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/i],
  ['bamboohr', /https?:\/\/([a-z0-9-]+)\.bamboohr\.com/i],
  ['smartrecruiters', /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ['personio', /https?:\/\/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i],
  ['teamtailor', /https?:\/\/([a-z0-9-]+)\.teamtailor\.com/i],
];
const ATS_SKIP = new Set(['www', 'api', 'apply', 'app', 'help', 'jobs', 'careers', 'embed', 'static', 'assets']);

function detectAts(pageUrl, html) {
  for (const src of [pageUrl, html]) {
    if (!src) continue;
    for (const [kind, re] of ATS_PATTERNS) {
      for (const m of String(src).matchAll(new RegExp(re.source, 'gi'))) {
        if (m[1] && !ATS_SKIP.has(m[1].toLowerCase())) return { kind, id: m[1].replace(/\.$/, '') };
      }
    }
  }
  // WordPress "WP Job Manager" plugin: jobs load in after the page opens.
  if (html && /wp-job-manager|class="job_listings|jm-ajax/i.test(html)) {
    try { return { kind: 'wpjm', id: new URL(pageUrl).origin }; } catch {}
  }
  return null;
}

async function fetchAtsOffers({ kind, id }) {
  const getJson = async u => {
    const r = await fetch(u, { headers: { 'Accept': 'application/json', 'User-Agent': 'DublinCoffeeJobsBot/1.0 (+https://dublincoffeejobs.com)' } });
    if (!r.ok) throw new Error(`${kind} feed ${r.status}`);
    return r.json();
  };
  const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const join = (...a) => a.filter(Boolean).join(', ');
  switch (kind) {
    case 'recruitee': {
      const f = await getJson(`https://${id}.recruitee.com/api/offers/`);
      return (f.offers || []).map(o => ({ title: o.title, location: join(o.city, o.country), type: o.employment_type_code || '',
        link: o.careers_url || o.careers_apply_url || '', about: strip(o.description) }));
    }
    case 'workable': {
      const f = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${id}`);
      return (f.jobs || []).map(j => ({ title: j.title, location: join(j.city, j.state, j.country), type: j.employment_type || '',
        link: j.url || j.shortlink || (j.shortcode ? `https://apply.workable.com/${id}/j/${j.shortcode}/` : ''), about: strip(j.description) }));
    }
    case 'greenhouse': {
      const f = await getJson(`https://boards-api.greenhouse.io/v1/boards/${id}/jobs`);
      return (f.jobs || []).map(j => ({ title: j.title, location: (j.location && j.location.name) || '', type: '', link: j.absolute_url || '', about: '' }));
    }
    case 'lever': {
      const f = await getJson(`https://api.lever.co/v0/postings/${id}?mode=json`);
      return (Array.isArray(f) ? f : []).map(j => ({ title: j.text, location: (j.categories && j.categories.location) || '',
        type: (j.categories && j.categories.commitment) || '', link: j.hostedUrl || '', about: strip(j.descriptionPlain || j.description) }));
    }
    case 'bamboohr': {
      const f = await getJson(`https://${id}.bamboohr.com/careers/list`);
      return (f.result || []).map(j => ({ title: j.jobOpeningName, location: join(j.location && j.location.city, j.location && j.location.state),
        type: j.employmentStatusLabel || '', link: `https://${id}.bamboohr.com/careers/${j.id}`, about: '' }));
    }
    case 'smartrecruiters': {
      // Irish jobs only: some accounts (e.g. BaxterStorey's parent) cover the UK too.
      const f = await getJson(`https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=100&country=ie`);
      return (f.content || []).map(j => ({ title: j.name, location: join(j.location && j.location.city, j.location && j.location.country),
        type: (j.typeOfEmployment && j.typeOfEmployment.label) || '', link: `https://jobs.smartrecruiters.com/${id}/${j.id}`, about: '' }));
    }
    case 'teamtailor': {
      const r = await fetch(`https://${id}.teamtailor.com/jobs.rss`, { headers: { 'Accept': 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' } });
      if (!r.ok) throw new Error('teamtailor feed ' + r.status);
      const xml = await r.text();
      const clean = v => String(v || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => {
        const tag = t => clean((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1]);
        const loc = [...m[1].matchAll(/<tt:(?:city|name)[^>]*>([\s\S]*?)<\/tt:(?:city|name)>/gi)].map(x => clean(x[1])).filter(Boolean);
        return { title: tag('title'), location: [...new Set(loc)].join(', '), type: '', link: tag('link'), about: tag('description').slice(0, 300) };
      }).filter(o => o.title);
      if (!items.length && !/<rss|<channel/i.test(xml)) throw new Error('teamtailor feed empty');
      return items;
    }
    case 'wpjm': {
      const origin = id;
      const clean = v => String(v || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;/g, "'").replace(/\s+/g, ' ').trim();
      // 1) the plugin's job feed
      try {
        const r = await fetch(`${origin}/?feed=job_feed`, { headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' } });
        const xml = r.ok ? await r.text() : '';
        if (/<item>/i.test(xml)) {
          return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => {
            const tag = t => clean((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1]);
            return { title: tag('title'), location: tag('job_listing:location'), type: tag('job_listing:job_type'), link: tag('link'), about: tag('description').slice(0, 300) };
          }).filter(o => o.title);
        }
      } catch {}
      // 2) the plugin's own listing request
      const r2 = await fetch(`${origin}/jm-ajax/get_listings/?per_page=50&page=1`, { headers: { 'Accept': 'application/json' } });
      if (!r2.ok) throw new Error('job list ' + r2.status);
      const j = await r2.json();
      const html = String(j.html || '');
      return [...html.matchAll(/<a[^>]+href="([^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<a[^>]+href=|$)/gi)].map(m => ({
        title: clean(m[2]), link: m[1],
        location: clean((m[3].match(/class="location"[^>]*>([\s\S]*?)<\//i) || [])[1]),
        type: clean((m[3].match(/class="job-type[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1]), about: '',
      })).filter(o => o.title);
    }
    case 'personio': {
      const r = await fetch(`https://${id}.jobs.personio.de/xml`);
      if (!r.ok) throw new Error('personio feed ' + r.status);
      const xml = await r.text();
      const tag = (blk, t) => ((blk.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(m => ({ title: tag(m[1], 'name'), location: tag(m[1], 'office'),
        type: tag(m[1], 'schedule'), link: `https://${id}.jobs.personio.de/job/${tag(m[1], 'id')}`, about: '' }));
    }
  }
  return [];
}

async function loadScanState(env, week) {
  const cur = await env.FDC_STORE.get('scan:state');
  const st = cur ? JSON.parse(cur) : null;
  if (st && st.week === week) return st;
  const old = await env.FDC_STORE.get(`scan:state:${week}`);
  return old ? JSON.parse(old) : null;
}

// Reads the JSON list out of an AI reply. If the reply was cut off part-way,
// keeps every complete item rather than losing the lot.
function parseJsonArray(reply) {
  const start = String(reply || '').indexOf('[');
  if (start < 0) return [];
  const body = reply.slice(start);
  const end = body.lastIndexOf(']');
  if (end > 0) { try { const v = JSON.parse(body.slice(0, end + 1)); if (Array.isArray(v)) return v; } catch {} }
  for (let cut = body.lastIndexOf('}'); cut > 0; cut = body.lastIndexOf('}', cut - 1)) {
    try { const v = JSON.parse(body.slice(0, cut + 1) + ']'); if (Array.isArray(v)) return v; } catch {}
  }
  return [];
}

// Fetches a careers page. Some sites give automated visitors a stripped-down
// or blocked page, so if the first attempt is blocked or nearly empty we try
// once more the way an ordinary browser asks for a page.
async function fetchPageHtml(url) {
  const readable = h => h.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  let res = await fetch(url, { headers: { 'User-Agent': 'DublinCoffeeJobsBot/1.0 (+https://dublincoffeejobs.com)', 'Accept': 'text/html' } });
  let html = res.ok ? (await res.text()).slice(0, 250000) : '';
  if (!res.ok || readable(html) < 2500) {
    try {
      const r2 = await fetch(url, { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IE,en;q=0.9' } });
      if (r2.ok) { const h2 = (await r2.text()).slice(0, 250000); if (readable(h2) > readable(html)) { html = h2; res = r2; } }
    } catch {}
  }
  if (!html && !res.ok) throw new Error('Page ' + res.status);
  return html;
}

// Extra content for careers pages built with website builders. Squarespace
// publishes every page as data (?format=json), including the posts of a
// listing page; most builders (Wix, Squarespace, Shopify…) also embed the
// page's content as data inside the page itself.
async function readBuilderData(pageUrl, html) {
  const out = { text: '', links: [] };
  const strip = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  let origin = ''; try { origin = new URL(pageUrl).origin; } catch {}
  if (/squarespace/i.test(html) || /#block-[0-9a-f]{24}/i.test(pageUrl)) {
    try {
      const u = new URL(pageUrl); u.hash = ''; u.searchParams.set('format', 'json');
      const r = await fetch(u.href, { headers: { 'Accept': 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const items = Array.isArray(j.items) ? j.items : [];
        for (const it of items.slice(0, 50)) {
          const href = cleanUrl(it.fullUrl ? new URL(it.fullUrl, origin).href : '');
          if (it.title) {
            out.text += `\n${it.title}${it.excerpt ? ' — ' + strip(it.excerpt).slice(0, 300) : ''}`;
            if (href) out.links.push({ text: String(it.title).slice(0, 80), href });
          }
        }
        if (j.mainContent) out.text += '\n' + strip(j.mainContent).slice(0, 20000);
      }
    } catch {}
  }
  // Text held as data inside the page (JSON in script tags).
  const bits = [];
  for (const m of String(html).matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const v of m[1].matchAll(/"(?:title|name|text|description|headline|label)"\s*:\s*"((?:[^"\\]|\\.){3,400})"/g)) {
      const t = v[1].replace(/\\n/g, ' ').replace(/\\u002F/gi, '/').replace(/\\"/g, '"').replace(/<[^>]+>/g, ' ').trim();
      if (t && !/^https?:/.test(t)) bits.push(t);
    }
  }
  if (bits.length) out.text += '\n' + [...new Set(bits)].join(' · ').slice(0, 15000);
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// WEEKLY NUMBERS — small daily counters (applications sent through the
// site, clicks to employers' own sites) for the "last 7 days" summary at
// the top of each scan email. Kept for 400 days for the sponsor pack.
// KV: stats:<YYYY-MM-DD> (Dublin date) → { applications, applyClicks }
// ═══════════════════════════════════════════════════════════════════
async function bumpStat(env, field) {
  try {
    const key = `stats:${dublinNow().date}`;
    const raw = await env.FDC_STORE.get(key);
    const st = raw ? JSON.parse(raw) : {};
    st[field] = (st[field] || 0) + 1;
    await env.FDC_STORE.put(key, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 400 });
  } catch (e) { console.error('stat bump failed', String(e)); }
}

async function weeklyNumbers(env, listings, now = Date.now()) {
  const totals = { applications: 0, applyClicks: 0 };
  for (let i = 0; i < 7; i++) {
    const day = dublinNow(new Date(now - i * 864e5)).date;
    const raw = await env.FDC_STORE.get(`stats:${day}`);
    if (raw) { const st = JSON.parse(raw); totals.applications += st.applications || 0; totals.applyClicks += st.applyClicks || 0; }
  }
  const live = listings.filter(l => !l.flagged && l.status === 'published');
  const newOnes = live.filter(l => l.createdAt > now - 7 * 864e5);
  let views = 0;
  for (const l of live.slice(0, 200)) {
    const v = await env.FDC_STORE.get(`views:${l.id}`);
    if (v) views += parseInt(v, 10) || 0;
  }
  return { newListings: newOnes.length, liveListings: live.length, views, ...totals };
}


// Employer sign-up from /employers. Sends to Klaviyo's public subscribe endpoint
// (list is double opt-in, so Klaviyo emails a confirmation). No secret key needed.
const KLAVIYO_COMPANY_ID = 'WEzjzU';
const KLAVIYO_EMPLOYER_LIST = 'SQ5mW4';

async function handleEmployerSignup(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400, origin); }
  if (body.website) return jsonResponse({ ok: true }, 200, origin); // honeypot: bots fill this
  const email = String(body.email || '').trim().toLowerCase();
  const business = String(body.business || '').trim().slice(0, 120);
  if (!business) return jsonResponse({ error: 'Please add your business name.' }, 400, origin);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return jsonResponse({ error: 'Please check your email address.' }, 400, origin);
  }
  const payload = {
    data: {
      type: 'subscription',
      attributes: {
        custom_source: 'DCJ employers page',
        profile: { data: { type: 'profile', attributes: {
          email, organization: business
        } } }
      },
      relationships: { list: { data: { type: 'list', id: KLAVIYO_EMPLOYER_LIST } } }
    }
  };
  const res = await fetch(`https://a.klaviyo.com/client/subscriptions?company_id=${KLAVIYO_COMPANY_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json', 'revision': '2024-10-15' },
    body: JSON.stringify(payload)
  });
  if (res.status >= 200 && res.status < 300) {
    try { await bumpStat(env, 'employer_signups'); } catch {}
    return jsonResponse({ ok: true }, 200, origin);
  }
  const kText = await res.text().catch(() => '');
  console.log('Klaviyo signup failed', res.status, kText);
  return jsonResponse({ error: 'Something went wrong. Please try again in a minute.', detail: `Klaviyo ${res.status}: ${kText.slice(0, 300)}` }, 502, origin);
}
