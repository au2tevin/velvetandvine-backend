// Velvet & Vine — Backend Server
// Handles: M-Pesa STK Push + Site Analytics Tracking
// Deploy free to render.com or railway.app

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const {
  MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE, MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  MPESA_ENV   = 'sandbox',
  PORT        = 3000,
  DASHBOARD_PASSWORD = 'velvet2024',   // change this in your .env!
  DATA_FILE   = './vv-data.json'
} = process.env;

const BASE = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ── DATA STORE (file-based, works on Render/Railway free tier) ───────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) { console.warn('readData error:', e.message); }
  return { visits: [], siteData: {} };
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
  } catch(e) { console.warn('writeData error:', e.message); }
}

// In-memory cache
let _store = readData();
function getStore() { return _store; }
function saveStore() { writeData(_store); }

// ── ANALYTICS TRACKING ────────────────────────────────────────────────────────

// POST /track  — called by the snippet in index.html on every page load
app.post('/track', (req, res) => {
  // Allow from any origin (your live site)
  res.header('Access-Control-Allow-Origin', '*');

  const { page, ref, ua, screen } = req.body;

  // Basic bot filter — ignore common crawlers
  const botPattern = /bot|crawler|spider|googlebot|bingbot|slurp|duckduck|baidu|yandex/i;
  if (ua && botPattern.test(ua)) {
    return res.json({ ok: true, tracked: false });
  }

  const visit = {
    ts:     Date.now(),
    page:   (page   || '/').slice(0, 200),
    ref:    (ref    || 'Direct').slice(0, 200),
    ua:     (ua     || '').slice(0, 300),
    screen: screen  || null,
    ip:     req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress
              || null
  };

  const store = getStore();
  store.visits.push(visit);

  // Keep last 10,000 visits to avoid unbounded growth
  if (store.visits.length > 10000) {
    store.visits = store.visits.slice(-10000);
  }

  saveStore();
  res.json({ ok: true, tracked: true });
});

// GET /analytics  — returns computed stats (password-protected)
app.get('/analytics', (req, res) => {
  const pwd = req.headers['x-dashboard-password'] || req.query.pwd;
  if (pwd !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const store  = getStore();
  const visits = store.visits || [];

  const now      = Date.now();
  const DAY      = 86400000;
  const today    = new Date().toDateString();

  // -- Totals
  const total     = visits.length;
  const todayV    = visits.filter(v => new Date(v.ts).toDateString() === today).length;
  const weekV     = visits.filter(v => now - v.ts < 7 * DAY).length;
  const monthV    = visits.filter(v => now - v.ts < 30 * DAY).length;

  // -- Daily counts for last 30 days
  const daily = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = d.toISOString().slice(0, 10);
    daily[key] = 0;
  }
  visits.forEach(v => {
    const key = new Date(v.ts).toISOString().slice(0, 10);
    if (daily[key] !== undefined) daily[key]++;
  });

  // -- Top pages
  const pageCounts = {};
  visits.forEach(v => {
    const p = v.page || '/';
    pageCounts[p] = (pageCounts[p] || 0) + 1;
  });
  const topPages = Object.entries(pageCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([page, count]) => ({ page, count }));

  // -- Referrers
  const refCounts = {};
  visits.forEach(v => {
    const r = v.ref || 'Direct';
    refCounts[r] = (refCounts[r] || 0) + 1;
  });
  const topReferrers = Object.entries(refCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ref, count]) => ({ ref, count }));

  // -- Devices
  const deviceCounts = { Desktop: 0, Mobile: 0, Tablet: 0, Unknown: 0 };
  visits.forEach(v => {
    const ua = v.ua || '';
    if (/mobile/i.test(ua))        deviceCounts.Mobile++;
    else if (/tablet|ipad/i.test(ua)) deviceCounts.Tablet++;
    else if (ua)                    deviceCounts.Desktop++;
    else                            deviceCounts.Unknown++;
  });

  // -- Recent visits (last 100, newest first)
  const recent = [...visits]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 100)
    .map(v => ({
      ts:   v.ts,
      page: v.page,
      ref:  v.ref,
      ua:   v.ua,
    }));

  res.json({
    ok: true,
    stats: {
      total, todayV, weekV, monthV,
      daily, topPages, topReferrers, deviceCounts, recent
    }
  });
});

// GET /analytics/clear  — wipe visit data (password-protected)
app.delete('/analytics/clear', (req, res) => {
  const pwd = req.headers['x-dashboard-password'];
  if (pwd !== DASHBOARD_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const store = getStore();
  store.visits = [];
  saveStore();
  res.json({ ok: true, message: 'Visit data cleared' });
});

// ── SITE DATA (existing CMS endpoints) ────────────────────────────────────────
app.get('/site/data', (req, res) => {
  const store = getStore();
  res.json({ success: true, data: store.siteData || {} });
});

app.patch('/site/data', (req, res) => {
  const { field, value } = req.body;
  if (!field) return res.status(400).json({ success: false, error: 'field required' });
  const store = getStore();
  if (!store.siteData) store.siteData = {};
  store.siteData[field] = value;
  saveStore();
  res.json({ success: true });
});

// ── M-PESA ────────────────────────────────────────────────────────────────────
async function getToken() {
  const creds = Buffer.from(MPESA_CONSUMER_KEY + ':' + MPESA_CONSUMER_SECRET).toString('base64');
  const r = await axios.get(BASE + '/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: 'Basic ' + creds }
  });
  return r.data.access_token;
}

app.post('/mpesa/stk-push', async (req, res) => {
  try {
    let { phone, amount, reference, description } = req.body;
    phone = phone.replace(/\D/g, '');
    if (phone.startsWith('0'))   phone = '254' + phone.slice(1);
    if (!phone.startsWith('254')) phone = '254' + phone;
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const pw = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString('base64');
    const token = await getToken();
    const r = await axios.post(BASE + '/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: MPESA_SHORTCODE, Password: pw, Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline', Amount: Math.ceil(Number(amount)),
      PartyA: phone, PartyB: MPESA_SHORTCODE, PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: reference    || 'VelvetVine',
      TransactionDesc:  description  || 'Velvet & Vine Payment'
    }, { headers: { Authorization: 'Bearer ' + token } });
    if (r.data.ResponseCode === '0')
      res.json({ success: true, checkoutRequestId: r.data.CheckoutRequestID, message: 'STK Push sent!' });
    else
      res.status(400).json({ success: false, message: r.data.ResponseDescription });
  } catch(e) {
    res.status(500).json({ success: false, message: e?.response?.data?.errorMessage || e.message });
  }
});

app.post('/mpesa/callback', (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (cb && cb.ResultCode === 0) {
    const meta = {};
    (cb.CallbackMetadata?.Item || []).forEach(i => meta[i.Name] = i.Value);
    console.log('PAYMENT SUCCESS:', meta);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/mpesa/status', async (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const pw = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString('base64');
    const token = await getToken();
    const r = await axios.post(BASE + '/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: MPESA_SHORTCODE, Password: pw,
      Timestamp: ts, CheckoutRequestID: req.body.checkoutRequestId
    }, { headers: { Authorization: 'Bearer ' + token } });
    res.json({ success: true, paid: r.data.ResultCode === '0', resultCode: r.data.ResultCode });
  } catch(e) {
    res.status(500).json({ success: false });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', env: MPESA_ENV, visits: getStore().visits?.length || 0 }));

app.listen(PORT, () => console.log(`Velvet & Vine server running on port ${PORT}`));
