/**
 * SEINBU CAPITAL — Backend Server v2 (Railway Edition)
 * Node.js / Express — Pi Network Payment API
 * Deployment: Railway.app
 */

require("dotenv").config();
const express    = require("express");
const helmet     = require("helmet");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");
const axios      = require("axios");
const { v4: uuidv4 } = require("uuid");

const app  = express();
const PORT = process.env.PORT || 4000;

// Trust Railway proxy
app.set('trust proxy', 1);

// ── SECURITY ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    "https://seinbu-one.vercel.app",
    "https://seinbu-one-git-main-seinbugroup-alts-projects.vercel.app",
    process.env.FRONTEND_URL || "http://localhost:3000",
  ],
  methods: ["GET","POST","PUT","OPTIONS"],
  credentials: true,
}));
app.use(express.json({ limit: "10kb" }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 100, message: "Trop de requetes" }));

// ── PI NETWORK CONFIG ─────────────────────────────────────────────
const PI_API_KEY  = process.env.PI_API_KEY  || "";
const PI_BASE_URL = "https://api.minepi.com";
const PI_GCV      = 314159 * 600;

// ── IN-MEMORY STORE ───────────────────────────────────────────────
const DB = {
  users:    new Map(),
  bonds:    new Map(),
  payments: new Map(),
  txns:     new Map(),
};

// ── BOND TIERS ────────────────────────────────────────────────────
const BOND_TIERS = {
  BRONZE:  { minPi:10,   maxPi:99,   annualRate:0.08, months:12 },
  ARGENT:  { minPi:100,  maxPi:499,  annualRate:0.10, months:24 },
  OR:      { minPi:500,  maxPi:999,  annualRate:0.12, months:36 },
  PLATINE: { minPi:1000, maxPi:null, annualRate:0.13, months:48 },
};

const generateBondId = (tier) => {
  const prefix = tier.slice(0,2).toUpperCase();
  const year   = new Date().getFullYear();
  const seq    = String(DB.bonds.size + 1).padStart(4,"0");
  return `SC-${prefix}-${year}-${seq}`;
};

const calcMaturityDate = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
};

// ── PI AUTH MIDDLEWARE ────────────────────────────────────────────
const requirePiAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ","");
  if (!token) return res.status(401).json({ error: "Token Pi requis" });
  req.piToken = token;
  next();
};

// ── VERIFY PI TOKEN ───────────────────────────────────────────────
const verifyPiToken = async (token) => {
  const resp = await axios.get(`${PI_BASE_URL}/v2/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Api-Key": PI_API_KEY,
    },
  });
  return resp.data;
};

// ── ROUTES ────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "SEINBU CAPITAL API",
    version: "2.0.0",
    status: "operational",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Auth Pi
app.post("/auth/pi", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: "accessToken requis" });
    const piUser = await verifyPiToken(accessToken);
    DB.users.set(piUser.uid, {
      uid: piUser.uid,
      username: piUser.username,
      lastLogin: new Date().toISOString(),
    });
    res.json({ success: true, user: { uid: piUser.uid, username: piUser.username } });
  } catch (e) {
    res.status(401).json({ error: "Token Pi invalide", details: e.message });
  }
});

// Bonds list
app.get("/bonds", (req, res) => {
  res.json({ tiers: BOND_TIERS, gcvFCFA: PI_GCV });
});

// Create bond payment
app.post("/bonds/subscribe", requirePiAuth, async (req, res) => {
  try {
    const { tier, piAmount } = req.body;
    if (!BOND_TIERS[tier]) return res.status(400).json({ error: "Palier invalide" });
    const t = BOND_TIERS[tier];
    if (piAmount < t.minPi || (t.maxPi && piAmount > t.maxPi)) {
      return res.status(400).json({ error: `Montant hors limite pour ${tier}` });
    }
    const paymentId = uuidv4();
    const bondId    = generateBondId(tier);
    DB.payments.set(paymentId, {
      paymentId, bondId, tier, piAmount,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    res.json({
      success: true,
      paymentId,
      bondId,
      memo: `Pi Bond ${tier} — ${bondId}`,
      amount: piAmount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve payment (called by Pi SDK callback)
app.post("/payments/approve", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "paymentId requis" });

    // Approve via Pi API
    await axios.post(
      `${PI_BASE_URL}/v2/payments/${paymentId}/approve`,
      {},
      { headers: { "X-Api-Key": PI_API_KEY } }
    );

    const payment = DB.payments.get(paymentId);
    if (payment) payment.status = "approved";

    res.json({ success: true, paymentId, status: "approved" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Complete payment (called after blockchain confirmation)
app.post("/payments/complete", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ error: "paymentId et txid requis" });

    // Complete via Pi API
    await axios.post(
      `${PI_BASE_URL}/v2/payments/${paymentId}/complete`,
      { txid },
      { headers: { "X-Api-Key": PI_API_KEY } }
    );

    const payment = DB.payments.get(paymentId);
    if (payment) {
      payment.status = "completed";
      payment.txid   = txid;

      // Créer le bond
      const t = BOND_TIERS[payment.tier];
      DB.bonds.set(payment.bondId, {
        bondId:     payment.bondId,
        tier:       payment.tier,
        piAmount:   payment.piAmount,
        annualRate: t.annualRate,
        months:     t.months,
        startDate:  new Date().toISOString().split("T")[0],
        endDate:    calcMaturityDate(t.months),
        txid,
        status: "active",
      });
    }

    res.json({ success: true, paymentId, txid, status: "completed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get user bonds
app.get("/bonds/user/:uid", (req, res) => {
  const userBonds = [...DB.bonds.values()].filter(b => b.uid === req.params.uid);
  res.json({ bonds: userBonds, count: userBonds.length });
});

// Stats
app.get("/stats", (req, res) => {
  res.json({
    totalBonds:    DB.bonds.size,
    totalUsers:    DB.users.size,
    totalPayments: DB.payments.size,
    gcvFCFA:       PI_GCV,
  });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SEINBU CAPITAL API v2 — Port ${PORT}`);
  console.log(`   PI_API_KEY: ${PI_API_KEY ? "✓ configurée" : "⚠ manquante"}`);
  console.log(`   Env: ${process.env.NODE_ENV || "development"}`);
});

module.exports = app;
