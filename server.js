/**
 * Wallet Activity Dashboard - backend
 * ------------------------------------
 * Receives Helius webhook events, enriches SWAP events with token symbol,
 * exact execution price, and market cap, then serves the dashboard.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Needed now: the server calls OUT to Helius (not just receives from it) to
// resolve token symbol/supply. Set this in Render's Environment tab.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

// Optional shared secret between Helius and this server (set the same value
// as the Helius webhook's "Authorization Header" field if you use one).
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const ACTIVITY_FILE = path.join(__dirname, "activity.json");
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const TOKEN_CACHE_FILE = path.join(__dirname, "token-cache.json");

const MAX_EVENTS = 500;
const LAMPORTS_PER_SOL = 1e9;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- simple JSON file persistence ----------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let events = loadJson(ACTIVITY_FILE, []);
let wallets = loadJson(WALLETS_FILE, {}); // { address: label }
let tokenCache = loadJson(TOKEN_CACHE_FILE, {}); // { mint: {symbol,name,decimals,supply,fetchedAt} }

// ---------- SOL/USD price, refreshed every few minutes ----------
let solUsdPrice = null;

async function refreshSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const data = await res.json();
    if (data && data.solana && data.solana.usd) {
      solUsdPrice = data.solana.usd;
    }
  } catch (e) {
    console.warn("[warn] failed to refresh SOL price:", e.message);
  }
}
refreshSolPrice();
setInterval(refreshSolPrice, 5 * 60 * 1000);

// ---------- token metadata (symbol, name, decimals, supply), cached forever per mint ----------
async function getTokenMeta(mint) {
  if (!mint) return null;
  if (tokenCache[mint]) return tokenCache[mint];
  if (!HELIUS_API_KEY) return null;

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-meta",
        method: "getAsset",
        params: { id: mint, displayOptions: { showFungible: true } },
      }),
    });
    const json = await res.json();
    const result = json.result;
    if (!result) return null;

    const symbol =
      (result.token_info && result.token_info.symbol) ||
      (result.content && result.content.metadata && result.content.metadata.symbol) ||
      null;
    const name =
      (result.content && result.content.metadata && result.content.metadata.name) || null;
    const decimals = result.token_info ? result.token_info.decimals : 0;
    const supplyRaw = result.token_info ? result.token_info.supply : null;
    const supply = supplyRaw != null ? supplyRaw / Math.pow(10, decimals) : null;

    const meta = { symbol, name, decimals, supply, fetchedAt: Date.now() };
    tokenCache[mint] = meta;
    saveJson(TOKEN_CACHE_FILE, tokenCache);
    return meta;
  } catch (e) {
    console.warn(`[warn] failed to fetch token meta for ${mint}:`, e.message);
    return null;
  }
}

// ---------- wallet labels ----------
app.get("/api/wallets", (req, res) => res.json(wallets));

app.post("/api/wallets", (req, res) => {
  const { address, label } = req.body || {};
  if (!address || !label) return res.status(400).json({ error: "address and label required" });
  wallets[address] = label;
  saveJson(WALLETS_FILE, wallets);
  res.json({ ok: true });
});

app.delete("/api/wallets/:address", (req, res) => {
  delete wallets[req.params.address];
  saveJson(WALLETS_FILE, wallets);
  res.json({ ok: true });
});

// ---------- parsing a Helius enhanced SWAP transaction ----------
// Note: Helius's exact JSON shape can vary slightly by DEX/source. This is
// defensive with fallbacks, but may need a small tweak once we see a real
// live payload from your wallets.
function extractSwapLegs(tx) {
  const swap = tx.events && tx.events.swap;
  if (swap) {
    const solLeg = swap.nativeInput || swap.nativeOutput;
    const tokenLeg =
      (swap.tokenOutputs && swap.tokenOutputs[0]) ||
      (swap.tokenInputs && swap.tokenInputs[0]);
    if (solLeg && tokenLeg) {
      const direction = swap.nativeInput ? "BUY" : "SELL";
      const solAmount = Number(solLeg.amount) / LAMPORTS_PER_SOL;
      const tokenAmount = Number(tokenLeg.tokenAmount);
      const mint = tokenLeg.mint;
      return { direction, solAmount, tokenAmount, mint };
    }
  }

  // Fallback: scan raw transfer arrays directly.
  const tokenTransfer = (tx.tokenTransfers || [])[0];
  const nativeTransfer = (tx.nativeTransfers || [])[0];
  if (tokenTransfer && nativeTransfer) {
    const direction = nativeTransfer.amount < 0 ? "SELL" : "BUY";
    return {
      direction,
      solAmount: Math.abs(nativeTransfer.amount) / LAMPORTS_PER_SOL,
      tokenAmount: Math.abs(tokenTransfer.tokenAmount),
      mint: tokenTransfer.mint,
    };
  }

  return null;
}

async function buildEvent(tx) {
  const signature = tx.signature || `${Date.now()}-${Math.random()}`;
  const timestamp = tx.timestamp ? tx.timestamp * 1000 : Date.now();
  const walletAddress =
    tx.feePayer || (tx.accountData && tx.accountData[0] && tx.accountData[0].account) || "unknown";
  const walletLabel = wallets[walletAddress] || null;

  const base = {
    id: signature,
    timestamp,
    walletAddress,
    walletLabel,
    type: tx.type || "UNKNOWN",
    description: tx.description || "",
  };

  if (tx.type !== "SWAP") return base;

  const legs = extractSwapLegs(tx);
  if (!legs) return base;

  const meta = await getTokenMeta(legs.mint);
  const priceInSol = legs.tokenAmount > 0 ? legs.solAmount / legs.tokenAmount : null;
  const priceUsd = priceInSol != null && solUsdPrice ? priceInSol * solUsdPrice : null;
  const marketCapUsd = priceUsd != null && meta && meta.supply ? priceUsd * meta.supply : null;

  return {
    ...base,
    direction: legs.direction,
    mint: legs.mint,
    symbol: (meta && meta.symbol) || null,
    tokenAmount: legs.tokenAmount,
    solAmount: legs.solAmount,
    priceUsd,
    marketCapUsd,
  };
}

// ---------- webhook endpoint ----------
app.post("/webhook", (req, res) => {
  if (WEBHOOK_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== WEBHOOK_SECRET) return res.status(403).send("forbidden");
  }
  res.status(200).send("ok"); // must ack within 1s; process the rest async

  const body = Array.isArray(req.body) ? req.body : [req.body];
  Promise.all(body.map(buildEvent))
    .then((newEvents) => {
      events = [...events, ...newEvents];
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      saveJson(ACTIVITY_FILE, events);
      console.log(`[webhook] stored ${newEvents.length} event(s)`);
    })
    .catch((e) => console.error("[error] processing webhook:", e));
});

app.get("/api/activity", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(events.slice(-limit).reverse());
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Wallet dashboard listening on port ${PORT}`);
});
