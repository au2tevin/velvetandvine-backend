// ╔══════════════════════════════════════════════════════════════╗
// ║  Velvet & Vine — Backend Server v2.0                        ║
// ║  M-Pesa STK Push + MongoDB site data persistence            ║
// ╚══════════════════════════════════════════════════════════════╝

const express    = require('express');
const cors       = require('cors');
const https      = require('https');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' })); // large limit for base64 images

// ── MongoDB ───────────────────────────────────────────────────
const MONGO_URI  = process.env.MONGO_URI;   // set in Render env vars
const DB_NAME    = 'velvetandvine';
let   db         = null;

async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(DB_NAME);
  console.log('✅ MongoDB connected');
  return db;
}

// Helper — get or create the single site-data document
async function getSiteDoc() {
  const col = (await connectDB()).collection('sitedata');
  let doc = await col.findOne({ _id: 'site' });
  if (!doc) {
    doc = {
      _id:        'site',
      backgrounds:{ hero:'', video:'', services:'', contact:'' },
      gallery:    [],
      svcPhotos:  ['','','','','',''],
      promoVideo: null,
      typography: null,
      products:   [],
      orders:     []
    };
    await col.insertOne(doc);
  }
  return doc;
}

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Velvet & Vine Backend v2', db: db ? 'connected' : 'disconnected' });
});

// ══════════════════════════════════════════════════════════════
// SITE DATA API
// ══════════════════════════════════════════════════════════════

// GET all site data (called on page load)
app.get('/site/data', async (_req, res) => {
  try {
    const doc = await getSiteDoc();
    res.json({ success: true, data: doc });
  } catch (e) {
    console.error('GET /site/data error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// PATCH a specific field (called whenever something changes)
// Body: { field: 'gallery', value: [...] }
app.patch('/site/data', async (req, res) => {
  try {
    const { field, value } = req.body;
    const ALLOWED = ['backgrounds','gallery','svcPhotos','promoVideo','typography','products','orders'];
    if (!ALLOWED.includes(field)) return res.status(400).json({ success: false, message: 'Unknown field: ' + field });
    const col = (await connectDB()).collection('sitedata');
    await col.updateOne({ _id: 'site' }, { $set: { [field]: value } }, { upsert: true });
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /site/data error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// M-PESA STK PUSH (unchanged from v1)
// ══════════════════════════════════════════════════════════════

const MPESA_ENV        = process.env.MPESA_ENV        || 'sandbox';
const CONSUMER_KEY     = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET  = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE        = process.env.MPESA_SHORTCODE   || '174379';
const PASSKEY          = process.env.MPESA_PASSKEY;
const CALLBACK_URL     = process.env.MPESA_CALLBACK_URL;

const BASE = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// In-memory store for callback results
const callbackResults = {};

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getToken() {
  const creds = Buffer.from(CONSUMER_KEY + ':' + CONSUMER_SECRET).toString('base64');
  return new Promise((resolve, reject) => {
    https.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: 'Basic ' + creds }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).access_token); }
        catch { reject(new Error('Token parse failed: ' + raw)); }
      });
    }).on('error', reject);
  });
}

app.post('/mpesa/stk-push', async (req, res) => {
  try {
    const { phone, amount, reference, description } = req.body;
    const token = await getToken();
    const ts    = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const pw    = Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');
    const result = await httpsPost(
      BASE.replace('https://', ''),
      '/mpesa/stkpush/v1/processrequest',
      { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      {
        BusinessShortCode: SHORTCODE, Password: pw, Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline', Amount: Math.ceil(amount),
        PartyA: phone, PartyB: SHORTCODE, PhoneNumber: phone,
        CallBackURL: CALLBACK_URL, AccountReference: reference || 'VV',
        TransactionDesc: description || 'Velvet & Vine Payment'
      }
    );
    if (result.ResponseCode === '0') {
      callbackResults[result.CheckoutRequestID] = { paid: false };
      res.json({ success: true, checkoutRequestId: result.CheckoutRequestID, message: result.CustomerMessage });
    } else {
      res.json({ success: false, message: result.errorMessage || result.ResponseDescription });
    }
  } catch (e) {
    console.error('STK push error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/mpesa/callback', (req, res) => {
  const cb   = req.body.Body?.stkCallback;
  const id   = cb?.CheckoutRequestID;
  const code = cb?.ResultCode;
  if (id) {
    if (code === 0) {
      const meta  = cb.CallbackMetadata?.Item || [];
      const ref   = meta.find(i => i.Name === 'MpesaReceiptNumber')?.Value || '';
      callbackResults[id] = { paid: true, mpesaRef: ref, resultCode: '0' };
    } else {
      callbackResults[id] = { paid: false, resultCode: String(code) };
    }
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/mpesa/status', (req, res) => {
  const { checkoutRequestId } = req.body;
  const result = callbackResults[checkoutRequestId] || { paid: false };
  res.json(result);
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Velvet & Vine backend running on port ${PORT}`));
