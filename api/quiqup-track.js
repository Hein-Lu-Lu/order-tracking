// /api/quiqup-track.js  (Vercel Serverless Function)
// Node 18+ on Vercel has global fetch.

let TOKEN = null;
let TOKEN_EXPIRES_AT = 0;

// Allow only your storefront(s)
function getAllowedOrigin(origin) {
  if (!origin) return null;
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return allowed.includes(origin) ? origin : null;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = getAllowedOrigin(origin);

  // Preflight
  if (req.method === "OPTIONS") {
    if (!allowedOrigin) return res.status(403).end();
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (!allowedOrigin) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { ref = "" } = req.query; // Quiqup order ID/reference (string)
    if (!ref) return res.status(400).json({ error: "Missing ref" });

    const token = await getQuiqupToken();

    const order = await fetchQuiqupOrder(ref, token);
    if (!order) return res.status(404).json({ error: "Order not found" });

    return res.status(200).json(shapeResponse(order, ref));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

async function getQuiqupToken() {
  const now = Date.now();
  if (TOKEN && now < TOKEN_EXPIRES_AT - 15_000) return TOKEN;

  const r = await fetch(`${process.env.QUIQUP_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.QUIQUP_CLIENT_ID,
      client_secret: process.env.QUIQUP_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("Quiqup auth failed");
  const j = await r.json();
  TOKEN = j.access_token;
  const expiresInMs = (j.expires_in || 3600) * 1000; // ~1h staging, ~7d prod
  TOKEN_EXPIRES_AT = Date.now() + expiresInMs;
  return TOKEN;
}

async function fetchQuiqupOrder(ref, token) {
  const readBase = process.env.QUIQUP_READ_BASE || process.env.QUIQUP_BASE;
  const url = `${readBase}/orders/${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.text();
  if (!r.ok) {
    console.error('Quiqup READ failed', r.status, body, 'URL:', url);
    return null;
  }
  return JSON.parse(body); // this returns { order: {...} }
}
function normalizeEta(ord) {
  const candidates = [
    ord.delivery_before,
    ord.delivery_time?.delivery_before,
    ord.delivery_time?.before,
    ord.delivery_time?.to,
    ord.delivery_time,
    ord.delivery?.before,
    ord.delivery?.eta,
    ord.eta
  ].filter(Boolean);

  let raw = candidates[0];
  if (!raw) return null;

  if (typeof raw === 'number') { if (raw < 1e12) raw *= 1000; return new Date(raw).toISOString(); }
  if (typeof raw === 'string') {
    let s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[Z+\-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    const dt = new Date(s);
    return isNaN(dt) ? null : dt.toISOString();
  }
  return null;
}
// Map the /orders JSON shape → what your page expects
function shapeResponse(obj, fallbackRef) {
  const ord = obj?.order || obj || {};
  const status = ord.state || ord.status || 'Unknown';

  return {
    reference: String(ord.id ?? fallbackRef),
    status,
    fulfillments: [{
      carrier: 'Quiqup',
      tracking_numbers: [ord.tracking_token].filter(Boolean),
      tracking_urls: [ord.tracking_url, ord.tracking_url_advance].filter(Boolean),
       eta: normalizeEta(ord),  
      events: [] // add later if you get a timeline endpoint
    }]
  };
}




