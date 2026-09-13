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
// A swap always has two "legs": what was given up, and what was received.
// One of those legs is usually a well-known "quote" currency (SOL, USDC,
// USDT) and the other is the actual coin of interest. We treat SOL/USDC/USDT
// as known quotes with a reliable USD value, and whichever leg ISN'T one of
// those is the coin we feature (ticker, contract address, market cap).
//
// Note: Helius's exact JSON shape can vary slightly by DEX/source. This is
// defensive with fallbacks, but may still need small tweaks as new edge
// cases show up.

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const KNOWN_QUOTES = {
  [WSOL_MINT]: { symbol: "SOL", isStable: false },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", isStable: true },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", isStable: true },
};

function buildLeg(mint, amount, isNative) {
  if (isNative) {
    // Native SOL leg: amount is in lamports.
    return { mint: WSOL_MINT, amount: Number(amount) / LAMPORTS_PER_SOL };
  }
  return { mint, amount: Number(amount) };
}

// Collect every input/output leg from the enhanced swap event into a flat
// list, tagging native SOL movements as the wrapped-SOL mint so they're
// comparable to token legs.
function collectLegs(swap) {
  const inputs = [];
  const outputs = [];

  if (swap.nativeInput) inputs.push(buildLeg(null, swap.nativeInput.amount, true));
  if (swap.nativeOutput) outputs.push(buildLeg(null, swap.nativeOutput.amount, true));
  (swap.tokenInputs || []).forEach((t) => inputs.push(buildLeg(t.mint, t.tokenAmount, false)));
  (swap.tokenOutputs || []).forEach((t) => outputs.push(buildLeg(t.mint, t.tokenAmount, false)));

  return { inputs, outputs };
}

// Among multiple legs on one side (e.g. a main swap amount plus a tiny
// referral-fee transfer), assume the largest amount is the real trade leg.
function biggestLeg(legs) {
  if (!legs || legs.length === 0) return null;
  return legs.reduce((a, b) => (b.amount > a.amount ? b : a));
}

function extractSwapLegs(tx) {
  const swap = tx.events && tx.events.swap;
  let inputs, outputs;

  if (swap) {
    ({ inputs, outputs } = collectLegs(swap));
  } else {
    // Fallback: build pseudo-legs from raw transfer arrays if there's no
    // parsed swap event at all.
    inputs = [];
    outputs = [];
    (tx.tokenTransfers || []).forEach((t) => {
      const leg = { mint: t.mint, amount: Math.abs(t.tokenAmount) };
      if (t.tokenAmount < 0) inputs.push(leg);
      else outputs.push(leg);
    });
    (tx.nativeTransfers || []).forEach((t) => {
      const leg = buildLeg(null, Math.abs(t.amount), true);
      if (t.amount < 0) inputs.push(leg);
      else outputs.push(leg);
    });
  }

  const inLeg = biggestLeg(inputs);
  const outLeg = biggestLeg(outputs);
  if (!inLeg || !outLeg) return null;

  const inIsQuote = KNOWN_QUOTES[inLeg.mint];
  const outIsQuote = KNOWN_QUOTES[outLeg.mint];

  // Figure out which leg is "the coin" (not a known quote currency) and
  // which is "the quote" (SOL/USDC/USDT) used to price it.
  let coinLeg, quoteLeg, direction;
  if (outIsQuote && !inIsQuote) {
    // Gave away a coin, received a known quote currency -> SELL
    coinLeg = inLeg;
    quoteLeg = outLeg;
    direction = "SELL";
  } else if (inIsQuote && !outIsQuote) {
    // Gave away a known quote currency, received a coin -> BUY
    coinLeg = outLeg;
    quoteLeg = inLeg;
    direction = "BUY";
  } else {
    // Both or neither leg is a known quote (e.g. SOL/USDC arbitrage, or two
    // unrecognized tokens). Fall back to treating the output as "the coin".
    coinLeg = outLeg;
    quoteLeg = inLeg;
    direction = "BUY";
  }

  const quoteInfo = KNOWN_QUOTES[quoteLeg.mint] || { symbol: null, isStable: false };

  return {
    direction,
    mint: coinLeg.mint,
    tokenAmount: coinLeg.amount,
    quoteAmount: quoteLeg.amount,
    quoteSymbol: quoteInfo.symbol,
    quoteIsStable: quoteInfo.isStable,
  };
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

  // A stablecoin quote (USDC/USDT) is worth ~$1, no extra lookup needed.
  // A SOL quote needs the live SOL/USD price.
  let quoteValueUsd = null;
  if (legs.quoteIsStable) {
    quoteValueUsd = legs.quoteAmount;
  } else if (legs.quoteSymbol === "SOL" && solUsdPrice) {
    quoteValueUsd = legs.quoteAmount * solUsdPrice;
  }

  const priceUsd =
    quoteValueUsd != null && legs.tokenAmount > 0 ? quoteValueUsd / legs.tokenAmount : null;
  const marketCapUsd = priceUsd != null && meta && meta.supply ? priceUsd * meta.supply : null;

  return {
    ...base,
    direction: legs.direction,
    mint: legs.mint,
    symbol: (meta && meta.symbol) || null,
    tokenAmount: legs.tokenAmount,
    quoteAmount: legs.quoteAmount,
    quoteSymbol: legs.quoteSymbol,
    quoteValueUsd,
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

  // TEMPORARY: log the raw payload so we can see Helius's exact field names
  // and fix parsing based on real data instead of guessing. Remove this
  // once parsing is confirmed correct.
  console.log("[debug] raw webhook payload:", JSON.stringify(req.body, null, 2));

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
