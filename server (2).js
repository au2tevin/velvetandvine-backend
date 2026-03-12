// Velvet & Vine — M-Pesa STK Push Backend
// 1. Install: npm install
// 2. Copy .env.example to .env and fill in your credentials
// 3. Run: node server.js
// 4. Deploy free to render.com or railway.app

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL, MPESA_ENV = 'sandbox', PORT = 3000 } = process.env;
const BASE = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

async function getToken() {
  const creds = Buffer.from(MPESA_CONSUMER_KEY+':'+MPESA_CONSUMER_SECRET).toString('base64');
  const r = await axios.get(BASE+'/oauth/v1/generate?grant_type=client_credentials', { headers:{ Authorization:'Basic '+creds } });
  return r.data.access_token;
}

app.post('/mpesa/stk-push', async (req, res) => {
  try {
    let { phone, amount, reference, description } = req.body;
    phone = phone.replace(/\D/g,'');
    if(phone.startsWith('0')) phone = '254'+phone.slice(1);
    if(!phone.startsWith('254')) phone = '254'+phone;
    const ts = new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
    const pw = Buffer.from(MPESA_SHORTCODE+MPESA_PASSKEY+ts).toString('base64');
    const token = await getToken();
    const r = await axios.post(BASE+'/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode:MPESA_SHORTCODE, Password:pw, Timestamp:ts,
      TransactionType:'CustomerPayBillOnline', Amount:Math.ceil(Number(amount)),
      PartyA:phone, PartyB:MPESA_SHORTCODE, PhoneNumber:phone,
      CallBackURL:MPESA_CALLBACK_URL, AccountReference:reference||'VelvetVine',
      TransactionDesc:description||'Velvet & Vine Payment'
    }, { headers:{ Authorization:'Bearer '+token } });
    if(r.data.ResponseCode === '0') res.json({ success:true, checkoutRequestId:r.data.CheckoutRequestID, message:'STK Push sent!' });
    else res.status(400).json({ success:false, message:r.data.ResponseDescription });
  } catch(e) { res.status(500).json({ success:false, message:e?.response?.data?.errorMessage||e.message }); }
});

app.post('/mpesa/callback', (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if(cb && cb.ResultCode === 0) {
    const meta = {}; (cb.CallbackMetadata?.Item||[]).forEach(i=>meta[i.Name]=i.Value);
    console.log('PAYMENT SUCCESS:', meta);
  }
  res.json({ ResultCode:0, ResultDesc:'Accepted' });
});

app.post('/mpesa/status', async (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
    const pw = Buffer.from(MPESA_SHORTCODE+MPESA_PASSKEY+ts).toString('base64');
    const token = await getToken();
    const r = await axios.post(BASE+'/mpesa/stkpushquery/v1/query', {
      BusinessShortCode:MPESA_SHORTCODE, Password:pw, Timestamp:ts, CheckoutRequestID:req.body.checkoutRequestId
    }, { headers:{ Authorization:'Bearer '+token } });
    res.json({ success:true, paid:r.data.ResultCode==='0', resultCode:r.data.ResultCode });
  } catch(e) { res.status(500).json({ success:false }); }
});

app.get('/health', (_,res) => res.json({ status:'ok', env:MPESA_ENV }));
app.listen(PORT, () => console.log('M-Pesa server running on port '+PORT));
