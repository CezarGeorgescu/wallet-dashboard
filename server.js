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

// ---------- fresh (uncached) live price lookup, for unrealized PNL ----------
// Unlike getTokenMeta (cached forever - symbol/supply rarely change), price
// changes constantly, so this always hits Helius fresh. Only called for
// tokens a wallet currently holds, and only when the Wallets tab is opened -
// not on every swap - so the extra cost stays small.
async function getLivePriceUsd(mint) {
  if (!HELIUS_API_KEY) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "live-price",
        method: "getAsset",
        params: { id: mint, displayOptions: { showFungible: true } },
      }),
    });
    const json = await res.json();
    const priceInfo = json.result && json.result.token_info && json.result.token_info.price_info;
    return priceInfo ? priceInfo.price_per_token : null;
  } catch (e) {
    console.warn(`[warn] failed to fetch live price for ${mint}:`, e.message);
    return null;
  }
}

// ---------- per-wallet, per-token PNL ----------
// Uses the "average cost" accounting method: every buy adds to a running
// average cost basis; every sell realizes profit/loss against that average
// (not FIFO/LIFO). This only needs data we already stored - no live price
// needed for realized PNL. Unrealized PNL (for tokens still held) is added
// separately since it needs a live price.
function computeWalletStats(address) {
  const walletSwaps = events
    .filter((e) => e.walletAddress === address && e.type === "SWAP" && e.mint)
    .sort((a, b) => a.timestamp - b.timestamp);

  const byMint = {};
  for (const ev of walletSwaps) {
    if (!byMint[ev.mint]) {
      byMint[ev.mint] = {
        mint: ev.mint,
        symbol: ev.symbol,
        buyAmountUsd: 0,
        buyMcapWeighted: 0,
        sellAmountUsd: 0,
        sellMcapWeighted: 0,
        realizedPnl: 0,
        tokensHeld: 0,
        costBasisUsd: 0,
      };
    }
    const t = byMint[ev.mint];
    if (ev.symbol) t.symbol = ev.symbol; // keep the most recently known symbol

    if (ev.direction === "BUY") {
      const usd = ev.quoteValueUsd || 0;
      t.buyAmountUsd += usd;
      if (ev.marketCapUsd != null && usd) t.buyMcapWeighted += ev.marketCapUsd * usd;
      t.tokensHeld += ev.tokenAmount || 0;
      t.costBasisUsd += usd;
    } else if (ev.direction === "SELL") {
      const sellUsd = ev.quoteValueUsd || 0;
      t.sellAmountUsd += sellUsd;
      if (ev.marketCapUsd != null && sellUsd) t.sellMcapWeighted += ev.marketCapUsd * sellUsd;

      const avgCostPerToken = t.tokensHeld > 0 ? t.costBasisUsd / t.tokensHeld : 0;
      // Guard against apparently selling more than we ever saw bought (e.g.
      // if the buy happened before this dashboard started tracking).
      const soldTokens = Math.min(ev.tokenAmount || 0, t.tokensHeld);
      const costBasisOfSold = avgCostPerToken * soldTokens;

      t.realizedPnl += sellUsd - costBasisOfSold;
      t.tokensHeld -= soldTokens;
      t.costBasisUsd -= costBasisOfSold;
    }
  }

  return Object.values(byMint).map((t) => ({
    mint: t.mint,
    symbol: t.symbol,
    buyAmountUsd: t.buyAmountUsd,
    avgBoughtMcap: t.buyAmountUsd > 0 ? t.buyMcapWeighted / t.buyAmountUsd : null,
    sellAmountUsd: t.sellAmountUsd,
    avgSoldMcap: t.sellAmountUsd > 0 ? t.sellMcapWeighted / t.sellAmountUsd : 0,
    realizedPnl: t.realizedPnl,
    remainingTokens: t.tokensHeld,
    remainingCostBasisUsd: t.costBasisUsd,
  }));
}

app.get("/api/wallet-stats/:address", async (req, res) => {
  const stats = computeWalletStats(req.params.address);

  await Promise.all(
    stats.map(async (s) => {
      if (s.remainingTokens > 1e-6) {
        const price = await getLivePriceUsd(s.mint);
        if (price != null) {
          s.currentPriceUsd = price;
          s.currentValueUsd = price * s.remainingTokens;
          s.unrealizedPnl = s.currentValueUsd - s.remainingCostBasisUsd;
        } else {
          s.currentPriceUsd = null;
          s.currentValueUsd = null;
          s.unrealizedPnl = null; // price unavailable (e.g. very new/illiquid token)
        }
      } else {
        s.currentPriceUsd = null;
        s.currentValueUsd = null;
        s.unrealizedPnl = null; // nothing currently held
      }
    })
  );

  // Most interesting (biggest total PNL, positive or negative) first.
  stats.sort((a, b) => {
    const totalA = a.realizedPnl + (a.unrealizedPnl || 0);
    const totalB = b.realizedPnl + (b.unrealizedPnl || 0);
    return totalB - totalA;
  });

  res.json(stats);
});

// Full swap history for one wallet. Note: bounded by MAX_EVENTS overall
// (the dashboard keeps the most recent 500 events across ALL wallets), so
// very old activity may have aged out - this isn't a complete lifetime
// history, just everything since this dashboard has been running.
app.get("/api/wallet-history/:address", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 200;
  const history = events
    .filter((e) => e.walletAddress === req.params.address)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
  res.json(history);
});

// ---------- parsing a Helius enhanced SWAP transaction ----------
// Helius doesn't always populate a clean "events.swap" object (confirmed
// empty on real PUMP_AMM/Fomo-routed swaps). Instead of relying on that, we
// compute the NET balance change per token for the wallet we're tracking,
// straight from the raw transfer arrays. Real trade amounts survive this;
// routing hops through intermediate accounts (e.g. wrapping/unwrapping SOL
// mid-route) cancel out to zero automatically, since the same amount goes
// out and comes back.

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const KNOWN_QUOTES = {
  [WSOL_MINT]: { symbol: "SOL", isStable: false },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", isStable: true },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", isStable: true },
};
const DUST_EPSILON = 1e-6; // ignore net amounts smaller than this (rounding noise)

// Which address in this transaction is "our" wallet? We use the set of
// addresses named in the dashboard (wallets.json) as the source of truth,
// since Helius's feePayer can be a fee-relayer/cosigner instead of the
// actual trader (confirmed: apps like Fomo cosign transactions).
function findWatchedAddress(tx) {
  const known = Object.keys(wallets);
  if (known.length === 0) return tx.feePayer || null;

  const candidates = new Set();
  (tx.tokenTransfers || []).forEach((t) => {
    if (t.fromUserAccount) candidates.add(t.fromUserAccount);
    if (t.toUserAccount) candidates.add(t.toUserAccount);
  });
  (tx.nativeTransfers || []).forEach((t) => {
    if (t.fromUserAccount) candidates.add(t.fromUserAccount);
    if (t.toUserAccount) candidates.add(t.toUserAccount);
  });

  for (const addr of known) {
    if (candidates.has(addr)) return addr;
  }
  return tx.feePayer || null; // fallback if no named wallet matches
}

// Net change per mint for one address: positive = received overall,
// negative = sent overall, across every transfer in the transaction.
//
// Deliberately only counts tokenTransfers (which includes wrapped-SOL
// movements) and NOT raw nativeTransfers. Confirmed on real data: apps like
// Fomo also move a small amount of native SOL as a separate fee/tip to
// their cosigner wallet, outside the actual swap. Including nativeTransfers
// double-counts that as if it were part of the trade. The swap's real SOL
// leg (if any) shows up as tokenTransfers on the wrapped-SOL mint.
function computeNetFlows(tx, address) {
  const net = {};
  (tx.tokenTransfers || []).forEach((t) => {
    if (t.toUserAccount === address) net[t.mint] = (net[t.mint] || 0) + t.tokenAmount;
    if (t.fromUserAccount === address) net[t.mint] = (net[t.mint] || 0) - t.tokenAmount;
  });
  return net;
}

function extractSwapLegs(tx) {
  const address = findWatchedAddress(tx);
  if (!address) return null;

  const net = computeNetFlows(tx, address);

  let coinMint = null,
    coinAmount = 0;
  let quoteNets = {}; // mint -> net amount, for known quote currencies only

  for (const [mint, amount] of Object.entries(net)) {
    if (Math.abs(amount) < DUST_EPSILON) continue; // routing noise, ignore
    if (KNOWN_QUOTES[mint]) {
      quoteNets[mint] = amount;
    } else if (Math.abs(amount) > Math.abs(coinAmount)) {
      coinMint = mint;
      coinAmount = amount;
    }
  }

  if (!coinMint) return null; // no real non-quote token movement found

  // Convert every quote currency's net flow to USD and sum it, so mixed
  // SOL+USDC fee structures (like the Fomo example) are handled correctly.
  let quoteValueUsd = 0;
  let dominantQuoteSymbol = null;
  let dominantQuoteAbs = 0;
  for (const [mint, amount] of Object.entries(quoteNets)) {
    const info = KNOWN_QUOTES[mint];
    const usdValue = info.isStable ? amount : solUsdPrice ? amount * solUsdPrice : null;
    if (usdValue != null) quoteValueUsd += usdValue;
    if (Math.abs(amount) > dominantQuoteAbs) {
      dominantQuoteAbs = Math.abs(amount);
      dominantQuoteSymbol = info.symbol;
    }
  }

  const direction = coinAmount > 0 ? "BUY" : "SELL";

  return {
    direction,
    mint: coinMint,
    tokenAmount: Math.abs(coinAmount),
    quoteValueUsd: Math.abs(quoteValueUsd) || null,
    quoteSymbol: dominantQuoteSymbol,
    quoteAmount: dominantQuoteAbs || null,
  };
}

async function buildEvent(tx) {
  const signature = tx.signature || `${Date.now()}-${Math.random()}`;
  const timestamp = tx.timestamp ? tx.timestamp * 1000 : Date.now();
  const watchedAddress = findWatchedAddress(tx);
  const walletAddress = watchedAddress || tx.feePayer || "unknown";
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
  const priceUsd =
    legs.quoteValueUsd != null && legs.tokenAmount > 0 ? legs.quoteValueUsd / legs.tokenAmount : null;
  const marketCapUsd = priceUsd != null && meta && meta.supply ? priceUsd * meta.supply : null;

  return {
    ...base,
    direction: legs.direction,
    mint: legs.mint,
    symbol: (meta && meta.symbol) || null,
    tokenAmount: legs.tokenAmount,
    quoteAmount: legs.quoteAmount,
    quoteSymbol: legs.quoteSymbol,
    quoteValueUsd: legs.quoteValueUsd,
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
