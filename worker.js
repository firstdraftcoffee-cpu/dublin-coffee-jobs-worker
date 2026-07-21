// ═══════════════════════════════════════════════════════════════
// First Draft Coffee — Unified Cloudflare Worker (v2)
// Handles: CV Review, Brew Compass, Job Listings, Shift Cover,
//          Stripe Checkout + Webhook, Flag/Report alerts
//
// NEW BINDINGS NEEDED (Cloudflare dashboard → Worker → Settings):
//   KV Namespace   : FDC_STORE           (create + bind this name)
//   Secret         : ANTHROPIC_API_KEY   (already set)
//   Secret         : STRIPE_SECRET_KEY   (from Stripe dashboard)
//   Secret         : STRIPE_WEBHOOK_SECRET (from Stripe webhook setup)
//   Secret         : ADMIN_TOKEN         (any long random string you pick —
//                                         used to authorise hide/remove actions
//                                         from the alert email links)
//   Variable       : ALERT_EMAIL_TO      (your inbox, e.g. ger@firstdraftcoffee.net)
//   Variable       : SITE_URL            (e.g. https://firstdraftcoffee.net)
//
// STRIPE SETUP:
//   1. Create two Prices in Stripe dashboard (or create Products+Prices via API):
//      - "Standard Listing"  one-off  €50
//      - "Featured Listing"  one-off  €100
//      (Shift-cover "need cover" post can reuse a smaller €10/€25 price —
//       see PRICE_IDS map below, fill in your real Stripe Price IDs)
//   2. Add a webhook endpoint in Stripe pointing to:
//      https://cv-review.firstdraftcoffee.workers.dev/webhook/stripe
//      Listen for: checkout.session.completed
//   3. Copy the webhook signing secret into STRIPE_WEBHOOK_SECRET
//
// Deploy: paste into Cloudflare Workers editor, or `wrangler deploy`
// ═══════════════════════════════════════════════════════════════

const PRICE_IDS = {
  job_standard:       'price_1TusgiJExrSWtqFLz37CJZd2', // Standard Job Listing — €35 / 14 days
  job_featured:       'price_1Tush8JExrSWtqFLF1xMwK7J', // Featured Job Listing — €50 / 30 days
  job_retainer:       'price_1TvNkVJExrSWtqFL22x9WWtN', // Monthly unlimited-posts subscription — €200/mo
  shift_need:         'price_1TvbIvJExrSWtqFLmhrDFPKU', // Standard Listing — €35 venue shift post / 7 days
  shift_need_urgent:  'price_1Tusg8JExrSWtqFLBMrLWFbD', // Urgent Staff Listing — €50 featured/urgent shift post
  cv_full:            'price_1TvbGRJExrSWtqFLSdBRAtZI', // CV Review — Full Review with rewritten summary — €10
};

const LISTING_DAYS = { job_standard: 14, job_featured: 30, shift_need: 7, shift_need_urgent: 7 };

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
      // ── EXISTING: CV REVIEW ─────────────────────────────────
      if ((path === '/cv' || path === '/' || path === '') && request.method === 'POST') {
        const { cv, role } = await request.json();
        if (!cv || cv.length < 100) return jsonResponse({ error: 'CV too short' }, 400, ALLOWED_ORIGIN);
        if (cv.length > 8000) return jsonResponse({ error: 'CV too long' }, 400, ALLOWED_ORIGIN);

        const prompt = `You are an expert recruiter specialising in the Dublin coffee and hospitality industry.
Review this CV for someone applying for a ${role || 'barista'} role in Dublin. Be specific, practical, and direct.
CV: ${cv}
Respond ONLY with a JSON object (no markdown, no backticks):
{"score":<1-100>,"scoreLabel":"<short phrase>","strengths":["...","...","..."],"improvements":["...","...","..."],"missingElements":["...","..."],"verdict":"<2-3 sentences>"}`;

        const data = await callClaude(prompt, env);
        const text = data.content.map(i => i.text || '').join('');
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return jsonResponse(parsed, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: CV FULL REVIEW — paid, starts Stripe Checkout ───
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

      // ── NEW: CV FULL REVIEW — fetch result once paid ─────────
      if (path === '/cv/full/result' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const raw = await env.FDC_STORE.get(`cvreview:${id}`);
        if (!raw) return jsonResponse({ error: 'Not found or expired' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);

        if (record.status === 'pending') return jsonResponse({ status: 'pending' }, 200, ALLOWED_ORIGIN);

        if (record.status === 'paid') {
          const prompt = `You are an expert recruiter specialising in the Dublin coffee and hospitality industry.
Give a detailed, line-by-line review of this CV for someone applying for a ${record.role || 'barista'} role. Be specific and practical.
CV: ${record.cv}
Respond ONLY with a JSON object (no markdown, no backticks):
{"lineNotes":["specific note on one part of the CV","...","..."],"rewrittenSummary":"<a rewritten 2-4 sentence professional summary/personal statement for this candidate, ready to paste at the top of their CV>"}`;
          const data = await callClaude(prompt, env);
          const text = data.content.map(i => i.text || '').join('');
          const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
          record.status = 'done';
          record.result = parsed;
          await env.FDC_STORE.put(`cvreview:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
          return jsonResponse({ status: 'done', result: parsed }, 200, ALLOWED_ORIGIN);
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

      // ── NEW: CREATE A LISTING (job or shift-need) — starts Stripe Checkout ──
      if (path === '/listings/create' && request.method === 'POST') {
        const body = await request.json();
        const { kind, tier, data } = body; // kind: 'job' | 'shift_need' | 'shift_available'
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

        // Free path: barista "available" posts skip Stripe entirely
        if (kind === 'shift_available') {
          record.status = 'published';
          const ttl = 14 * 24 * 60 * 60; // 14 days
          record.expiresAt = Date.now() + ttl * 1000;
          await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
          return jsonResponse({ published: true, id }, 200, ALLOWED_ORIGIN);
        }

        // Free path: active subscriber posting a job — skip Stripe entirely
        if (kind === 'job' && data.email) {
          const subscribed = await hasActiveSubscription(data.email, env);
          if (subscribed) {
            record.status = 'published';
            record.tier = 'subscriber';
            const ttl = 30 * 24 * 60 * 60; // 30 days, repost any time while subscribed
            record.expiresAt = Date.now() + ttl * 1000;
            await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record), { expirationTtl: ttl });
            ctx.waitUntil(postToSocial(record, env));
            ctx.waitUntil(notifyGroupPost(record, env));
            return jsonResponse({ published: true, id }, 200, ALLOWED_ORIGIN);
          }
        }

        // Paid path: job listings + venue shift-need posts
        const priceKey = kind === 'job' ? `job_${tier}` : `shift_${tier}`;
        const priceId = PRICE_IDS[priceKey];
        if (!priceId) return jsonResponse({ error: 'Unknown tier' }, 400, ALLOWED_ORIGIN);

        // Store the pending record for 24h — cleaned up if payment never completes
        await env.FDC_STORE.put(`pending:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });

        const session = await createStripeCheckoutSession({
          priceId,
          listingId: id,
          email: data.email,
          successUrl: `${env.SITE_URL}/posted?success=1&id=${id}`,
          cancelUrl: `${env.SITE_URL}/posted?cancelled=1`,
        }, env);

        return jsonResponse({ checkoutUrl: session.url }, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: SUBSCRIBE — unlimited job posts for a flat monthly price ──
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

      // ── NEW: STRIPE WEBHOOK — auto-publish on successful payment ──
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
              }
              // Optional: fire your existing Zapier webhook here to crosspost to Facebook
              // await fetch(env.ZAPIER_WEBHOOK_URL, { method: 'POST', body: JSON.stringify(record) });
            }
          } else if (reviewId) {
            const raw = await env.FDC_STORE.get(`cvreview:${reviewId}`);
            if (raw) {
              const record = JSON.parse(raw);
              record.status = 'paid';
              await env.FDC_STORE.put(`cvreview:${reviewId}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 });
            }
          }
        }
        return new Response('ok', { status: 200 });
      }

      // ── NEW: LIST ACTIVE LISTINGS ────────────────────────────
      if (path === '/listings' && request.method === 'GET') {
        const kind = url.searchParams.get('kind'); // optional filter: job | shift_need | shift_available
        const list = await env.FDC_STORE.list({ prefix: 'listing:' });
        const items = [];
        for (const key of list.keys) {
          const raw = await env.FDC_STORE.get(key.name);
          if (!raw) continue;
          const record = JSON.parse(raw);
          if (record.flagged) continue; // hidden pending your review
          if (kind && record.kind !== kind) continue;
          const viewsRaw = await env.FDC_STORE.get(`views:${record.id}`);
          record.views = viewsRaw ? parseInt(viewsRaw, 10) : 0;
          items.push(record);
        }
        items.sort((a, b) => b.createdAt - a.createdAt);
        return jsonResponse({ items }, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: VIEW COUNTER — one increment per card render ────
      if (path === '/listings/view' && request.method === 'POST') {
        const { id } = await request.json();
        if (!id) return jsonResponse({ error: 'Missing id' }, 400, ALLOWED_ORIGIN);
        const current = await env.FDC_STORE.get(`views:${id}`);
        const next = (current ? parseInt(current, 10) : 0) + 1;
        await env.FDC_STORE.put(`views:${id}`, String(next), { expirationTtl: 60 * 60 * 24 * 45 });
        return jsonResponse({ views: next }, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: SAVED-SEARCH ALERTS — email when a matching listing appears ──
      if (path === '/alerts/create' && request.method === 'POST') {
        const { email, kind, role, area, minRate } = await request.json();
        if (!email || !kind) return jsonResponse({ error: 'Email and kind are required' }, 400, ALLOWED_ORIGIN);
        const id = crypto.randomUUID();
        const alert = { id, email, kind, role: role || '', area: area || '', minRate: minRate || 0, createdAt: Date.now(), lastChecked: Date.now() };
        await env.FDC_STORE.put(`alert:${id}`, JSON.stringify(alert), { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResponse({ created: true }, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: FLAG / REPORT A LISTING — alerts you by email ───
      if (path === '/flag' && request.method === 'POST') {
        const { listingId, reason } = await request.json();
        if (!listingId) return jsonResponse({ error: 'Missing listingId' }, 400, ALLOWED_ORIGIN);

        const raw = await env.FDC_STORE.get(`listing:${listingId}`);
        if (!raw) return jsonResponse({ error: 'Listing not found' }, 404, ALLOWED_ORIGIN);
        const record = JSON.parse(raw);
        record.flagged = true; // hides it from the board immediately
        record.flagReason = reason || 'No reason given';
        await env.FDC_STORE.put(`listing:${listingId}`, JSON.stringify(record));

        const hideUrl = `${env.SITE_URL}`; // hidden already; link below is for permanent delete
        const deleteUrl = `${new URL(request.url).origin}/admin/delete?id=${listingId}&token=${env.ADMIN_TOKEN}`;
        const restoreUrl = `${new URL(request.url).origin}/admin/restore?id=${listingId}&token=${env.ADMIN_TOKEN}`;

        await sendAlertEmail(env, {
          subject: `[Dublin Coffee Jobs] Listing flagged — ${record.data?.title || record.data?.role || 'untitled'}`,
          text: `A listing was reported and has been auto-hidden from the board.\n\nReason: ${record.flagReason}\n\nListing summary: ${JSON.stringify(record.data, null, 2)}\n\nPermanently delete: ${deleteUrl}\nRestore (false alarm): ${restoreUrl}`,
        });

        return jsonResponse({ flagged: true }, 200, ALLOWED_ORIGIN);
      }

      // ── NEW: ADMIN ACTIONS (one-click from the alert email) ──
      if (path === '/admin/delete' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403 });
        await env.FDC_STORE.delete(`listing:${id}`);
        return new Response('Listing deleted permanently. You can close this tab.', { status: 200 });
      }
      if (path === '/admin/restore' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const token = url.searchParams.get('token');
        if (token !== env.ADMIN_TOKEN) return new Response('Forbidden', { status: 403 });
        const raw = await env.FDC_STORE.get(`listing:${id}`);
        if (raw) {
          const record = JSON.parse(raw);
          record.flagged = false;
          await env.FDC_STORE.put(`listing:${id}`, JSON.stringify(record));
        }
        return new Response('Listing restored to the board. You can close this tab.', { status: 200 });
      }

      // ── NEW: APPLY — sends the application by email server-side, so a
      // candidate's CV (pasted once, remembered in their browser) doesn't
      // need re-attaching for every job ──
      if (path === '/apply' && request.method === 'POST') {
        const { employerEmail, name, candidateEmail, role, about, cv, jobTitle } = await request.json();
        if (!employerEmail || !name || !candidateEmail) {
          return jsonResponse({ error: 'Missing required fields' }, 400, ALLOWED_ORIGIN);
        }
        const subject = `Application: ${jobTitle || 'Role'} — ${name}`;
        const text = `New application via Dublin Coffee Jobs\n\nRole: ${jobTitle || ''}\nName: ${name}\nEmail: ${candidateEmail}\nRole/experience: ${role || ''}\n${about ? '\nNote: ' + about + '\n' : ''}\n${cv ? '\n--- CV ---\n' + cv + '\n' : '\n(No CV text provided)\n'}`;
        await sendEmailTo(env, employerEmail, subject, text, candidateEmail);
        return jsonResponse({ sent: true }, 200, ALLOWED_ORIGIN);
      }

      return jsonResponse({ error: 'Unknown endpoint' }, 404, ALLOWED_ORIGIN);

    } catch (err) {
      return jsonResponse({ error: 'Something went wrong', detail: String(err) }, 500, ALLOWED_ORIGIN);
    }
  },

  // Runs on the cron schedule set in wrangler.toml (hourly). Checks every
  // saved alert against listings created since it last ran, and emails a
  // digest of matches. Updates lastChecked so nothing gets emailed twice.
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
  }
};

// ── HELPERS ──────────────────────────────────────────────────────

async function callClaude(prompt, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  return res.json();
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
  });
}

// Checks Stripe for a customer with this email who has an active subscription
// to the job_retainer price. Used to let subscribers post free.
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

// Creates a Stripe Checkout Session via plain REST call (no SDK needed in Workers)
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

// Verifies a Stripe webhook signature using Web Crypto (HMAC-SHA256)
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

// Emails you the ready-to-paste post text for the Dublin Coffee Jobs
// Facebook Group, since Meta removed the ability for any app to post into
// Groups automatically in 2024. Same caption as the auto-posted Instagram/
// Facebook Page post — just copy, paste into the Group, done.
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

// Cross-posts a newly published job or shift-need listing to the Facebook
// Page and Instagram Business account. Fire-and-forget — failures here
// never block the listing itself from going live. Needs three secrets set
// in Cloudflare: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, IG_USER_ID.
async function postToSocial(record, env) {
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.FB_PAGE_ID) return; // not configured yet
  const d = record.data;
  const isJob = record.kind === 'job';
  const url = isJob ? `${env.SITE_URL}/job-board.html?id=${record.id}` : `${env.SITE_URL}/shift-cover.html?id=${record.id}`;
  const caption = isJob
    ? `New job: ${d.title} at ${d.venue}\n${d.location} · ${d.salary} · ${d.type}\n\nApply: ${url}\n\n#DublinJobs #HospitalityJobs #DublinCoffeeJobs`
    : `Shift cover needed: ${d.role} at ${d.venue}\n${d.location} · ${d.date} ${d.hours} · ${d.rate}\n\nDetails: ${url}\n\n#DublinJobs #HospitalityJobs #DublinCoffeeJobs`;

  try {
    // Facebook Page post (text + link, no image required)
    await fetch(`https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message: caption, link: url, access_token: env.FB_PAGE_ACCESS_TOKEN }).toString(),
    });
  } catch (e) { /* fail quietly, listing already live regardless */ }

  try {
    // Instagram requires an image — reuse a fixed branded photo for now
    if (env.IG_USER_ID) {
      const imageUrl = `${env.SITE_URL}/${isJob ? 'job-board-hero.jpg' : 'shift-cover-hero.jpg'}`;
      const createRes = await fetch(`https://graph.facebook.com/v19.0/${env.IG_USER_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrl, caption, access_token: env.FB_PAGE_ACCESS_TOKEN }).toString(),
      });
      const created = await createRes.json();
      if (created.id) {
        await fetch(`https://graph.facebook.com/v19.0/${env.IG_USER_ID}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ creation_id: created.id, access_token: env.FB_PAGE_ACCESS_TOKEN }).toString(),
        });
      }
    }
  } catch (e) { /* fail quietly, listing already live regardless */ }
}

// Sends an email to any address — used for saved-search alert digests and
// job applications. Pass replyTo so the recipient can reply straight to
// the candidate rather than to the noreply alerts address.
async function sendEmailTo(env, to, subject, text, replyTo) {
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'alerts@firstdraftcoffee.net', name: 'Dublin Coffee Jobs' },
    subject,
    content: [{ type: 'text/plain', value: text }],
  };
  if (replyTo) payload.reply_to = { email: replyTo };
  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// Sends an alert email via MailChannels — free on Cloudflare Workers,
// requires SPF/DKIM records on firstdraftcoffee.net (one-time DNS setup,
// see README-setup.md). No API key needed.
async function sendAlertEmail(env, { subject, text }) {
  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.ALERT_EMAIL_TO }] }],
      from: { email: 'alerts@firstdraftcoffee.net', name: 'Dublin Coffee Jobs — Alerts' },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });
}
