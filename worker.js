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
          ctx.waitUntil(sendListingConfirmation(record, env));
          return jsonResponse({ published: true, id }, 200, ALLOWED_ORIGIN);
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
              const d = target.data || {};
              const text = `Here's the contact info you paid to reveal:\n\nRole: ${d.role || 'Barista'}\nArea: ${d.area || ''}\n${d.rate ? 'Min. rate: ' + d.rate + '\n' : ''}\nEmail: ${d.email || 'not provided'}\n${d.whatsapp ? 'WhatsApp: ' + d.whatsapp + '\n' : ''}\nReach out directly — this is between you and them from here.`;
              ctx.waitUntil(sendEmailTo(env, revealBuyerEmail, 'Contact details unlocked', text));
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
        return jsonResponse({ record }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/listings/view' && request.method === 'POST') {
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const current = await env.FDC_STORE.get(`views:${id}`);
        const next = (current ? parseInt(current, 10) : 0) + 1;
        await env.FDC_STORE.put(`views:${id}`, String(next), { expirationTtl: 60 * 60 * 24 * 45 });
        return jsonResponse({ views: next }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/alerts/create' && request.method === 'POST') {
        const { email, kind, role, area, minRate } = await request.json();
        if (!email || !kind) return jsonResponse({ error: 'Email and kind are required' }, 400, ALLOWED_ORIGIN);
        const id = crypto.randomUUID();
        const alert = { id, email, kind, role: role || '', area: area || '', minRate: minRate || 0, createdAt: Date.now(), lastChecked: Date.now() };
        await env.FDC_STORE.put(`alert:${id}`, JSON.stringify(alert), { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResponse({ created: true }, 200, ALLOWED_ORIGIN);
      }

      if (path === '/flag' && request.method === 'POST') {
        const { listingId, reason } = await request.json();
        if (!listingId) return jsonResponse({ error: 'Missing listingId' }, 400, ALLOWED_ORIGIN);

        const raw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!raw) return jsonResponse({ error: 'Listing not found' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        record.flagged = true;
        record.flagReason = reason || 'No reason given';
        await env.FDC_STORE.put(`listing:${listingId}`, JSON.stringify(record));

        const deleteUrl = `${new URL(request.url).origin}/admin/delete?id=${listingId}&token=${env.ADMIN_TOKEN}`;
        const restoreUrl = `${new URL(request.url).origin}/admin/restore?id=${listingId}&token=${env.ADMIN_TOKEN}`;

        await sendAlertEmail(env, {
          subject: `[Dublin Coffee Jobs] Listing flagged — ${record.data?.title || record.data?.role || 'untitled'}`,
          text: `A listing was reported and has been auto-hidden from the board.\n\nReason: ${record.flagReason}\n\nListing summary: ${JSON.stringify(record.data, null, 2)}\n\nPermanently delete: ${deleteUrl}\nRestore (false alarm): ${restoreUrl}`,
        });

        return jsonResponse({ flagged: true }, 200, ALLOWED_ORIGIN);
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
          await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record));
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
        const { employerEmail, name, candidateEmail, role, about, cv, cvFileUrl, jobTitle, listingId } = await request.json();
        if (!employerEmail || !name || !candidateEmail) {
          return jsonResponse({ error: 'Missing required fields' }, 400, ALLOWED_ORIGIN);
        }

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
        if (listingId) {
          const listingRaw = await env.FDC_STORE.get(`listing:${listingId}`);
          if (listingRaw) {
            const listing = JSON.parse(listingRaw);
            skipScoring = !!listing.data.skipScoring;
            digestMode = !!listing.data.digestMode;
            jobDesc = listing.data.desc || '';
          }
        }

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

async function notifyGroupPost(record, env) {
  if (!env.ALERT_EMAIL_TO) return;
  const d = record.data;
  const isJob = record.kind === 'job';
  const url = isJob ? `${env.SITE_URL}/job-board.html?id=${record.id}` : `${env.SITE_URL}/shift-cover.html?id=${record.id}`;
  const caption = isJob
    ? `New job: ${d.title} at ${d.venue}\n${d.location} · ${d.salary} · ${d.type}\n\nApply: ${url}`
    : `Shift cover needed: ${d.role} at ${d.venue}\n${d.location} · ${d.date} ${d.hours} · ${d.rate}\n\nDetails: ${url}`;
  await sendEmailTo(env, env.ALERT_EMAIL_TO, `Paste into the DCJ Group: ${d.title || d.role}`, `A new listing just went live and posted to Instagram + the Facebook Page automatically.\n\nThe Facebook Group still needs a manual paste (Meta doesn't allow apps to auto-post into Groups) — here's the text, ready to copy:\n\n---\n${caption}\n---`);
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
  const d = record.data;
  const isJob = record.kind === 'job';
  const url = isJob ? `${env.SITE_URL}/job-board.html?id=${record.id}` : `${env.SITE_URL}/shift-cover.html?id=${record.id}`;
  const caption = isJob
    ? `New job: ${d.title} at ${d.venue}\n${d.location} · ${d.salary} · ${d.type}\n\nApply: ${url}\n\n#DublinJobs #HospitalityJobs #DublinCoffeeJobs`
    : `Shift cover needed: ${d.role} at ${d.venue}\n${d.location} · ${d.date} ${d.hours} · ${d.rate}\n\nDetails: ${url}\n\n#DublinJobs #HospitalityJobs #DublinCoffeeJobs`;

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
