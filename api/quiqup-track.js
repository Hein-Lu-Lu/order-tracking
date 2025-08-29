// File: api/quiqup-track.js
// This is a Vercel Serverless Function.
// It receives ?ref=QUIQUP_REFERENCE and returns delivery status JSON.

import crypto from 'node:crypto';

export default async function handler(req, res) {
  try {
    // 1) (Recommended) Verify the request actually came from your Shopify App Proxy
    if (!verifyShopifyProxy(req)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { ref = '' } = req.query;
    if (!ref) return res.status(400).json({ error: 'Missing ref' });

    // 2) Get OAuth token from Quiqup
    const token = await getQuiqupToken();

    // 3) Call Quiqup order endpoint
    const order = await fetchQuiqupOrder(ref, token);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // 4) Shape a friendly payload for your page
    return res.status(200).json(shapeResponse(order, ref));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ---- Helpers ----

function verifyShopifyProxy(req) {
  // App Proxy sends ?signature=... which is HMAC-SHA256 over the OTHER query params
  const url = new URL(req.url, `https://${req.headers.host}`);
  const all = Object.fromEntries(url.searchParams.entries());
  const signature = all.signature;
  if (!signature || !process.env.SHOPIFY_APP_SECRET) return false;

  delete all.signature;
  const message = Object.keys(all)
    .sort()
    .map((k) => `${k}=${all[k]}`)
    .join('');

  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_APP_SECRET)
    .update(message)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

let TOKEN = null;
let TOKEN_EXPIRES_AT = 0;

async function getQuiqupToken() {
  const now = Date.now();
  if (TOKEN && now < TOKEN_EXPIRES_AT - 15_000) return TOKEN;

  const r = await fetch(`${process.env.QUIQUP_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.QUIQUP_CLIENT_ID,
      client_secret: process.env.QUIQUP_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error('Quiqup auth failed');
  const j = await r.json();
  TOKEN = j.access_token;
  const expiresIn = (j.expires_in || 3600) * 1000;
  TOKEN_EXPIRES_AT = Date.now() + expiresIn;
  return TOKEN;
}

async function fetchQuiqupOrder(ref, token) {
  const r = await fetch(
    `${process.env.QUIQUP_BASE}/api/fulfilment/orders/${encodeURIComponent(ref)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  return await r.json();
}

function shapeResponse(order, fallbackRef) {
  const status =
    order.status ||
    order.displayStatus ||
    order.displayFulfilmentStatus ||
    'Unknown';

  const fulfilments =
    order.fulfilments ||
    order.fulfillments ||
    [];

  return {
    reference: order.id || order.reference || fallbackRef,
    status,
    fulfillments: fulfilments.map((f) => ({
      carrier: f.trackingCompany || f.carrier || null,
      tracking_numbers: (f.trackingInfo || [])
        .map((t) => t.number)
        .filter(Boolean),
      tracking_urls: (f.trackingInfo || []).map((t) => t.url).filter(Boolean),
      eta: f.estimatedDeliveryAt || f.eta || null,
      events: (f.events || []).map((e) => ({
        time: e.happenedAt || e.time || e.timestamp,
        description: e.status || e.description,
        location: [e.city, e.province, e.country].filter(Boolean).join(', '),
      })),
    })),
  };
}
