/**
 * Wallet Activity Dashboard - backend
 * ------------------------------------
 * Receives Helius webhook events (real-time, fired when a watched wallet
 * transacts), stores them, and serves a small dashboard that shows the
 * live feed and fires browser notifications.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "activity.json");

// Optional: set WEBHOOK_SECRET as an env var and put the same value as the
// "Authorization" header when creating your Helius webhook, so random
// internet traffic can't post fake events to your dashboard.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const MAX_EVENTS = 500; // keep the feed from growing forever

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function loadEvents() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveEvents(events) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(events.slice(-MAX_EVENTS), null, 2));
}

let events = loadEvents();

function summarize(tx) {
  const type = tx.type || "UNKNOWN";
  const description = tx.description || "";
  const wallet =
    (tx.accountData && tx.accountData[0] && tx.accountData[0].account) ||
    (tx.feePayer) ||
    "unknown";
  return {
    id: tx.signature || `${Date.now()}-${Math.random()}`,
    wallet,
    type,
    description,
    timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
  };
}

// Helius sends an array of enhanced transaction objects to this endpoint.
app.post("/webhook", (req, res) => {
  if (WEBHOOK_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== WEBHOOK_SECRET) {
      return res.status(403).send("forbidden");
    }
  }

  // Acknowledge immediately (Helius requires a 200 within 1 second).
  res.status(200).send("ok");

  const body = Array.isArray(req.body) ? req.body : [req.body];
  const newEvents = body.map(summarize);
  events = [...events, ...newEvents];
  saveEvents(events);
  console.log(`[webhook] stored ${newEvents.length} event(s)`);
});

// Dashboard polls this for the current feed.
app.get("/api/activity", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(events.slice(-limit).reverse());
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Wallet dashboard listening on port ${PORT}`);
});
