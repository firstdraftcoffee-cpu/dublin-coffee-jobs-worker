// FDC C Price Worker
// ─────────────────────────────────────────────────────────────────────────
// Fetches the ICE Coffee C futures price (Arabica, ticker KC) from
// API Ninjas' Commodity Price API and serves it as small JSON payload for
// the FDC Roasting Hub's Pricing tab. The API key lives here as a Worker
// secret, never in the frontend, so it can't be read out of the browser.
//
// Free-tier API Ninjas data is 15-minutes delayed, not tick-by-tick live —
// genuinely real-time exchange data is licensed and paid. This Worker also
// caches its own response for 15 minutes on Cloudflare's edge, so the
// upstream API only gets hit a handful of times an hour regardless of how
// many times the Hub itself is loaded.
//
// Setup (one-time):
//   1. Get a free API key from https://api.api-ninjas.com/ (sign up, then
//      find the key on your account page).
//   2. npx wrangler login
//   3. npx wrangler secret put API_NINJAS_KEY   (paste the key when prompted)
//   4. npx wrangler deploy
//   5. Note the *.workers.dev URL it prints — that's C_PRICE_WORKER_URL in
//      the Hub's App.jsx.

const UPSTREAM_URL = "https://api.api-ninjas.com/v1/commodityprice?name=coffee";
const CACHE_SECONDS = 900; // 15 minutes — matches the free-tier data delay, no point polling faster

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + "/c-price", request);

    let cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstreamRes;
    try {
      upstreamRes = await fetch(UPSTREAM_URL, {
        headers: { "X-Api-Key": env.API_NINJAS_KEY },
      });
    } catch (err) {
      return jsonResponse({ error: "Could not reach the price source. Try again shortly." }, 502);
    }

    if (!upstreamRes.ok) {
      return jsonResponse(
        { error: `Price source returned an error (${upstreamRes.status}).` },
        502
      );
    }

    const data = await upstreamRes.json();

    // Normalise to just what the Hub needs — no point shipping the whole
    // upstream payload if half of it isn't used.
    const payload = {
      price: data.price ?? null,
      previous_close: data.previous_close ?? null,
      change_24h: data.change_24h ?? null,
      change_24h_percent: data.change_24h_percent ?? null,
      currency_unit: data.currency_unit ?? "USX", // US cents per lb, per API Ninjas' convention
      unit: data.unit ?? "lb",
      exchange: data.exchange ?? "ICE",
      updated: data.updated ?? null, // upstream's own timestamp
      fetched_at: Date.now(), // when THIS worker last actually hit the API
    };

    const response = jsonResponse(payload, 200, CACHE_SECONDS);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function jsonResponse(obj, status, cacheSeconds) {
  const headers = {
    "Content-Type": "application/json",
    ...corsHeaders(),
  };
  if (cacheSeconds) {
    headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(obj), { status, headers });
}
