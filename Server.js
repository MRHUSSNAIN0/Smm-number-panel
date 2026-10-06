require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD_HASH = bcrypt.hashSync("Ilovemom95@", 10);
const JWT_SECRET = process.env.JWT_SECRET || "mrf-super-secret-key-2025";
const MRF_API_BASE = "https://mrfsms.com/api/v1";
const MRF_API_KEY = process.env.MRF_API_KEY || "mrf_eb45ad32a65b91b8951407b7656dfe3fbfbee4be719d993877dff3881a376e24";
const MRF_HEADERS = {
  "Authorization": `Bearer ${MRF_API_KEY}`,
  "Content-Type": "application/json"
};
const EASYPAISA_NUMBER = "03154571648";
const EASYPAISA_NAME = "Sabir Ali";
const MARGIN_PERCENT = 50;
const CANCEL_WINDOW_SECONDS = 10;
const AUTO_EXPIRY_MINUTES = 26;

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DATABASE ====================
const DB_FILE = "db.json";

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e){}
  }
  return { users: {}, orders: {}, topups: {}, used_tids: {} };
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ==================== AUTH ====================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || !bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username });
});

// ==================== HELPERS ====================
function applyMargin(p) { return Math.ceil(p * (1 + MARGIN_PERCENT / 100)); }

// ==================== PUBLIC API ====================
app.get('/api/health', (req, res) => res.json({ status: "ok" }));

app.get('/api/payment-info', (req, res) => {
  res.json({
    easypaisa: EASYPAISA_NUMBER,
    name: EASYPAISA_NAME,
    cancelWindow: CANCEL_WINDOW_SECONDS,
    autoExpiry: AUTO_EXPIRY_MINUTES
  });
});

app.get('/api/mrf-balance', async (req, res) => {
  try {
    const r = await axios.get(`${MRF_API_BASE}/balance`, { headers: MRF_HEADERS });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/services', async (req, res) => {
  try {
    const r = await axios.get(`${MRF_API_BASE}/services`, { headers: MRF_HEADERS });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/countries/:service', async (req, res) => {
  try {
    const r = await axios.get(`${MRF_API_BASE}/services/${req.params.service}/countries`,
      { headers: MRF_HEADERS });
    if (r.data.countries) {
      r.data.countries = r.data.countries.map(c => ({
        ...c, price: c.price ? applyMargin(c.price) : null
      }));
    }
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/buy', async (req, res) => {
  try {
    const { service, countryId } = req.body;
    if (!service || !countryId) {
      return res.status(400).json({ error: "service and countryId required" });
    }
    const r = await axios.post(`${MRF_API_BASE}/orders`,
      { service, countryId }, { headers: MRF_HEADERS });

    const db = loadDB();
    db.orders[r.data.orderId] = {
      ...r.data,
      service,
      countryId,
      price: r.data.price ? applyMargin(r.data.price) : 200,
      createdAt: Date.now(),
      status: r.data.status || "pending"
    };
    saveDB(db);

    res.json({ ...r.data, createdAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});

app.get('/api/order/:orderId', async (req, res) => {
  try {
    const r = await axios.get(`${MRF_API_BASE}/orders/${req.params.orderId}`,
      { headers: MRF_HEADERS });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cancel/:orderId', async (req, res) => {
  try {
    const r = await axios.post(`${MRF_API_BASE}/orders/${req.params.orderId}/cancel`,
      {}, { headers: MRF_HEADERS });

    const db = loadDB();
    if (db.orders[req.params.orderId]) {
      db.orders[req.params.orderId].status = "cancelled";
      db.orders[req.params.orderId].cancelledAt = new Date().toISOString();
      saveDB(db);
    }
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.response?.data?.error || e.message }); }
});

// ==================== TOP-UP (User) ====================
app.post('/api/topup', (req, res) => {
  const { amount, txnId, userContact } = req.body;

  if (!amount || parseInt(amount) < 100) {
    return res.status(400).json({ error: "Minimum Rs.100" });
  }
  if (!txnId || txnId.trim().length < 4) {
    return res.status(400).json({ error: "Valid Transaction ID required" });
  }

  const db = loadDB();

  if (db.used_tids[txnId.trim()]) {
    return res.status(400).json({ error: "Yeh Transaction ID pehle use ho chuki hai" });
  }

  const topupId = `TOP${Date.now()}`;
  db.topups[topupId] = {
    id: topupId,
    amount: parseInt(amount),
    txnId: txnId.trim(),
    userContact: userContact || "Not provided",
    status: "Pending",
    createdAt: new Date().toISOString()
  };
  saveDB(db);

  res.json({
    success: true,
    topupId,
    message: "Admin Easypaisa app mein verify karega, 5-30 min"
  });
});

// ==================== ADMIN API ====================
app.get('/api/admin/orders', authMiddleware, (req, res) => {
  const db = loadDB();
  const orders = Object.values(db.orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ orders, total: orders.length });
});

app.get('/api/admin/topups', authMiddleware, (req, res) => {
  const db = loadDB();
  const topups = Object.values(db.topups).sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ topups, total: topups.length });
});

app.post('/api/admin/topup/:id/approve', authMiddleware, (req, res) => {
  const db = loadDB();
  const t = db.topups[req.params.id];
  if (!t) return res.status(404).json({ error: "Not found" });
  if (t.status !== "Pending") return res.status(400).json({ error: "Already processed" });
  if (db.used_tids[t.txnId]) return res.status(400).json({ error: "TID already used" });

  t.status = "Approved";
  t.approvedAt = new Date().toISOString();
  db.used_tids[t.txnId] = {
    topupId: t.id,
    amount: t.amount,
    at: new Date().toISOString()
  };
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/topup/:id/reject', authMiddleware, (req, res) => {
  const db = loadDB();
  const t = db.topups[req.params.id];
  if (!t) return res.status(404).json({ error: "Not found" });
  if (t.status !== "Pending") return res.status(400).json({ error: "Already processed" });

  t.status = "Rejected";
  t.rejectedAt = new Date().toISOString();
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/admin/stats', authMiddleware, (req, res) => {
  const db = loadDB();
  const orders = Object.values(db.orders);
  const topups = Object.values(db.topups);
  const revenue = orders.reduce((s, o) => s + (o.price || 0), 0);
  const approved = topups.filter(t => t.status === "Approved").reduce((s, t) => s + t.amount, 0);
  const today = new Date().toDateString();

  res.json({
    totalOrders: orders.length,
    activeOrders: orders.filter(o => o.status === "active" || o.status === "pending").length,
    completedOrders: orders.filter(o => o.status === "completed").length,
    totalTopups: topups.length,
    pendingTopups: topups.filter(t => t.status === "Pending").length,
    approvedTopups: topups.filter(t => t.status === "Approved").length,
    totalRevenue: revenue,
    totalTopupAmount: approved,
    todayOrders: orders.filter(o => new Date(o.createdAt).toDateString() === today).length
  });
});

// ==================== SERVE PAGES ====================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ==================== AUTO EXPIRY ====================
setInterval(async () => {
  const db = loadDB();
  let changed = false;
  for (const [orderId, o] of Object.entries(db.orders)) {
    if (o.status !== "pending" && o.status !== "active") continue;
    const elapsed = (Date.now() - (o.createdAt || Date.now())) / 60000;
    if (elapsed < AUTO_EXPIRY_MINUTES) continue;
    try {
      const check = await axios.get(`${MRF_API_BASE}/orders/${orderId}`, { headers: MRF_HEADERS });
      if (check.data.otpCode) {
        o.status = "completed";
        o.otpCode = check.data.otpCode;
      } else {
        await axios.post(`${MRF_API_BASE}/orders/${orderId}/cancel`, {}, { headers: MRF_HEADERS });
        o.status = "expired";
        o.expiredAt = new Date().toISOString();
      }
      changed = true;
    } catch (e) { console.error("Expiry check:", e.message); }
  }
  if (changed) saveDB(db);
}, 60000);

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`\n✅ Website: http://localhost:${PORT}`);
  console.log(`🎛️  Admin:   http://localhost:${PORT}/admin`);
  console.log(`🔑 Login:   admin / Ilovemom95@\n`);
});
