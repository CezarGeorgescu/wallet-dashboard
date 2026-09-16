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

// Optional: set these to get a Telegram push notification on every trade,
// so you're alerted even when your computer is off/asleep. Both must be
// set for alerts to fire; if either is missing, alerts are silently
// skipped (everything else keeps working normally).
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Optional shared secret between Helius and this server (set the same value
// as the Helius webhook's "Authorization Header" field if you use one).
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Where data files live. On Render, __dirname is wiped on every redeploy -
// set DATA_DIR to a mounted persistent disk's path (e.g. /var/data) in
// Render's Environment tab so activity/wallets/cache survive redeploys.
// Falls back to __dirname for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const WALLETS_FILE = path.join(DATA_DIR, "wallets.json");
const TOKEN_CACHE_FILE = path.join(DATA_DIR, "token-cache.json");

// Raised now that storage is persistent (was 500) - at 100 wallets, a small
// cap fills up almost immediately. This is still a plain JSON file, not a
// real database, so don't push this into the hundreds of thousands -
// rewriting a huge file on every single event will eventually get slow. If
// you outgrow this, the next step is a real database instead of raising
// this further.
const MAX_EVENTS = 20000;

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
let tokenCache = loadJson(TOKEN_CACHE_FILE, {}); // { mint: {symbol,name,decimals,supply,fetchedAt} }

// wallets.json used to be { address: "label" } (Solana-only). Now that we
// support multiple chains, each entry needs a chain tag too. Old entries
// are migrated in-memory on load (assumed Solana, since that's all that
// existed before); the file itself gets rewritten in the new shape the
// next time anything saves.
function migrateWallets(raw) {
  const migrated = {};
  for (const [addr, val] of Object.entries(raw)) {
    migrated[addr] = typeof val === "string" ? { label: val, chain: "solana" } : val;
  }
  return migrated;
}
let wallets = migrateWallets(loadJson(WALLETS_FILE, {})); // { address: {label, chain} }

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

let ethUsdPrice = null;
async function refreshEthPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await res.json();
    if (data && data.ethereum && data.ethereum.usd) {
      ethUsdPrice = data.ethereum.usd;
    }
  } catch (e) {
    console.warn("[warn] failed to refresh ETH price:", e.message);
  }
}
refreshEthPrice();
setInterval(refreshEthPrice, 5 * 60 * 1000);

let bnbUsdPrice = null;
async function refreshBnbPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd"
    );
    const data = await res.json();
    if (data && data.binancecoin && data.binancecoin.usd) {
      bnbUsdPrice = data.binancecoin.usd;
    }
  } catch (e) {
    console.warn("[warn] failed to refresh BNB price:", e.message);
  }
}
refreshBnbPrice();
setInterval(refreshBnbPrice, 5 * 60 * 1000);

// ---------- Telegram push alerts ----------
// Fires on every stored trade event, same content as what shows in the
// Feed tab. No-ops silently if the env vars aren't set.
function formatPrice(n) {
  if (n == null) return "N/A";
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 9;
  return "$" + n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatNumberCompact(n) {
  if (n == null) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramAlert(ev) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const who = escapeHtml(ev.walletLabel || ev.walletAddress);
  let text;

  if (ev.type === "SWAP" && ev.mint !== undefined) {
    const emoji = ev.direction === "BUY" ? "\u{1F7E2}" : "\u{1F534}";
    const ticker = ev.symbol ? escapeHtml(ev.symbol) : "unknown token";
    const onSource = ev.source ? ` on ${escapeHtml(ev.source)}` : "";

    // <code> renders as monospace and is tap-to-copy in Telegram clients -
    // this is what makes the contract address copyable.
    const caLine = ev.mint ? `<code>${escapeHtml(ev.mint)}</code> (${who})` : who;

    // Both legs of the trade, formatted for the "swapped X for Y" line and
    // the per-asset balance-change summary below it.
    const coinAmountFmt = ev.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const quoteAmountFmt = ev.quoteAmount != null ? ev.quoteAmount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "?";
    const usdFmt = ev.quoteValueUsd != null ? `$${ev.quoteValueUsd.toFixed(2)}` : "N/A";
    const quoteSym = escapeHtml(ev.quoteSymbol || "?");

    let swappedLine, balanceLines;
    if (ev.direction === "BUY") {
      swappedLine = `\u{1F537} ${who} swapped ${quoteAmountFmt} (${usdFmt}) ${quoteSym} for ${coinAmountFmt} (${usdFmt}) ${ticker}`;
      balanceLines = `${ticker}: +${coinAmountFmt} (${usdFmt})\n${quoteSym}: -${quoteAmountFmt} (-${usdFmt})`;
    } else {
      swappedLine = `\u{1F537} ${who} swapped ${coinAmountFmt} (${usdFmt}) ${ticker} for ${quoteAmountFmt} (${usdFmt}) ${quoteSym}`;
      balanceLines = `${quoteSym}: +${quoteAmountFmt} (${usdFmt})\n${ticker}: -${coinAmountFmt} (-${usdFmt})`;
    }

    // Current holdings after this trade, computed from stored history - no
    // live price needed. % of supply uses the free on-chain supply fetched
    // alongside the token's symbol (see getTokenMeta).
    let holdsLine = "";
    let avgBoughtLine = "";
    let realizedPnlLine = "";
    const stats = computeWalletStats(ev.walletAddress).find((s) => s.mint === ev.mint);
    if (stats) {
      const pct = ev.supply ? ` (${((stats.remainingTokens / ev.supply) * 100).toFixed(2)}%)` : "";
      holdsLine = `\u{1F36F} Holds: ${formatNumberCompact(stats.remainingTokens)}${pct}`;

      if (stats.avgBoughtPrice != null && ev.supply) {
        const avgBoughtMcap = stats.avgBoughtPrice * ev.supply;
        avgBoughtLine = `\n\u{1F4CA} Avg B: $${formatNumberCompact(avgBoughtMcap)} MC`;
      }

      const pnlSign = stats.realizedPnl > 0 ? "+" : stats.realizedPnl < 0 ? "-" : "";
      realizedPnlLine = `\n\u{1F4B0} Realized PNL: ${pnlSign}$${Math.abs(stats.realizedPnl).toFixed(2)}`;
    }

    const mcLine = ev.marketCapUsd != null ? `\n\u{1F4C8} MC: $${formatNumberCompact(ev.marketCapUsd)}` : "";

    text =
      `${emoji} ${ev.direction} ${ticker}${onSource}\n` +
      `${caLine}\n\n` +
      `${swappedLine}${mcLine}\n` +
      `${holdsLine}${avgBoughtLine}${realizedPnlLine}\n\n` +
      `\u{1F537} ${who}:\n` +
      `${balanceLines}`;
  } else {
    text = `\u{1F4E9} ${escapeHtml(ev.type)}\n${who}${ev.chain ? ` \u2022 ${escapeHtml(ev.chain)}` : ""}\n${escapeHtml(ev.description || "")}`;
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("[warn] failed to send Telegram alert:", e.message);
  }
}

// ---------- token metadata (symbol, name), cached forever per mint ----------
// Reads directly from Solana on-chain data via a free public RPC node - costs
// ZERO Helius credits, no matter how many new tokens appear.
//
// Two possible sources, tried in order:
// 1. Classic Metaplex Token Metadata program - a separate PDA account, used
//    by older/standard SPL tokens. Layout stable since program launch.
// 2. Token-2022's embedded metadata extension - newer tokens (confirmed:
//    some current pump.fun launches) store name/symbol/uri directly inside
//    the mint account itself via a TLV-encoded extension, not a separate
//    PDA. Verified byte-for-byte against a real FUZED mint account before
//    shipping this - see the TokenMetadata Interface layout below.
//
// We no longer fetch "supply" here since we dropped market cap - price is
// computed for free from the swap itself (spent/received divided by token
// amount), so there was no other reason left to call a paid endpoint.
const { PublicKey } = require("@solana/web3.js");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_2022_METADATA_EXTENSION_TYPE = 19; // ExtensionType::TokenMetadata
const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

async function rpcGetAccountInfo(address) {
  const res = await fetch(PUBLIC_SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "token-meta",
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
  });
  const json = await res.json();
  return json.result && json.result.value;
}

// Free, separate from price - total supply doesn't need a paid DAS call,
// just a standard RPC method. Works for any Solana token, not just
// pump.fun's fixed 1B ones.
async function rpcGetTokenSupply(mint) {
  try {
    const res = await fetch(PUBLIC_SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-supply",
        method: "getTokenSupply",
        params: [mint],
      }),
    });
    const json = await res.json();
    const value = json.result && json.result.value;
    return value ? value.uiAmount : null; // already decimal-adjusted
  } catch (e) {
    console.warn(`[warn] failed to fetch token supply for ${mint}:`, e.message);
    return null;
  }
}

function readBorshString(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  const value = buffer.slice(offset + 4, offset + 4 + length).toString("utf8");
  return { value, nextOffset: offset + 4 + length };
}

// Classic Metaplex layout: key(1) + updateAuthority(32) + mint(32) = 65 byte
// header, then Borsh strings: name, then symbol.
function parseMetaplexNameSymbol(buffer) {
  let offset = 65;
  const name = readBorshString(buffer, offset);
  offset = name.nextOffset;
  const symbol = readBorshString(buffer, offset);
  return { name: name.value.replace(/\0/g, "").trim(), symbol: symbol.value.replace(/\0/g, "").trim() };
}

// Token-2022 embedded metadata: find the TLV extension of type 19
// (TokenMetadata) by scanning for a header whose declared length reaches
// exactly to the end of the account data (true for the last/only metadata
// extension - verified against real data). Payload layout per the SPL Token
// Metadata Interface: update_authority(32) + mint(32) + name(String) +
// symbol(String) + ...
function parseToken2022NameSymbol(buffer) {
  for (let pos = 0; pos < buffer.length - 4; pos++) {
    const extType = buffer.readUInt16LE(pos);
    const extLen = buffer.readUInt16LE(pos + 2);
    if (extType === TOKEN_2022_METADATA_EXTENSION_TYPE && pos + 4 + extLen === buffer.length) {
      let offset = pos + 4 + 32 + 32; // skip header, update_authority, mint
      const name = readBorshString(buffer, offset);
      offset = name.nextOffset;
      const symbol = readBorshString(buffer, offset);
      return { name: name.value, symbol: symbol.value };
    }
  }
  return null;
}

async function getTokenMeta(mint) {
  if (!mint) return null;
  if (tokenCache[mint]) return tokenCache[mint];

  try {
    const mintPubkey = new PublicKey(mint);

    // Try 1: classic Metaplex PDA.
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    );
    const metaplexAccount = await rpcGetAccountInfo(metadataPda.toBase58());

    let result = null;
    if (metaplexAccount) {
      const buffer = Buffer.from(metaplexAccount.data[0], "base64");
      result = parseMetaplexNameSymbol(buffer);
    } else {
      // Try 2: Token-2022 embedded metadata, read from the mint account itself.
      const mintAccount = await rpcGetAccountInfo(mint);
      if (mintAccount) {
        const buffer = Buffer.from(mintAccount.data[0], "base64");
        result = parseToken2022NameSymbol(buffer);
      }
    }

    if (!result) {
      // Genuinely no metadata found either way. Don't cache this - could be
      // a transient RPC issue rather than the token truly having none.
      return null;
    }

    const supply = await rpcGetTokenSupply(mint); // free, separate call - doesn't block symbol resolution if it fails
    const meta = { symbol: result.symbol || null, name: result.name || null, supply, fetchedAt: Date.now() };
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
  const { address, label, chain } = req.body || {};
  if (!address || !label) return res.status(400).json({ error: "address and label required" });
  wallets[address] = { label, chain: chain || "solana" };
  saveJson(WALLETS_FILE, wallets);
  res.json({ ok: true });
});

app.delete("/api/wallets/:address", (req, res) => {
  delete wallets[req.params.address];
  saveJson(WALLETS_FILE, wallets);
  res.json({ ok: true });
});

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
        buyPriceWeighted: 0,
        sellAmountUsd: 0,
        sellPriceWeighted: 0,
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
      if (ev.priceUsd != null && usd) t.buyPriceWeighted += ev.priceUsd * usd;
      t.tokensHeld += ev.tokenAmount || 0;
      t.costBasisUsd += usd;
    } else if (ev.direction === "SELL") {
      const sellUsd = ev.quoteValueUsd || 0;
      t.sellAmountUsd += sellUsd;
      if (ev.priceUsd != null && sellUsd) t.sellPriceWeighted += ev.priceUsd * sellUsd;

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
    avgBoughtPrice: t.buyAmountUsd > 0 ? t.buyPriceWeighted / t.buyAmountUsd : null,
    sellAmountUsd: t.sellAmountUsd,
    avgSoldPrice: t.sellAmountUsd > 0 ? t.sellPriceWeighted / t.sellAmountUsd : 0,
    realizedPnl: t.realizedPnl,
    remainingTokens: t.tokensHeld,
    remainingCostBasisUsd: t.costBasisUsd,
  }));
}

app.get("/api/wallet-stats/:address", (req, res) => {
  const stats = computeWalletStats(req.params.address);
  // Most interesting (biggest realized PNL, positive or negative) first.
  stats.sort((a, b) => b.realizedPnl - a.realizedPnl);
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
  // Only consider wallets tagged for Solana - now that wallets.json can
  // hold EVM addresses too, mixing them in here would let an EVM address
  // accidentally "match" (extremely unlikely in practice since formats
  // differ completely, but filtering explicitly is the correct approach).
  const known = Object.keys(wallets).filter((addr) => wallets[addr].chain === "solana");
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
  const walletLabel = (wallets[walletAddress] && wallets[walletAddress].label) || null;

  const base = {
    id: signature,
    timestamp,
    walletAddress,
    walletLabel,
    chain: "solana",
    type: tx.type || "UNKNOWN",
    description: tx.description || "",
    source: tx.source || null, // e.g. "JUPITER", "PUMP_AMM" - which DEX the trade went through
  };

  if (tx.type !== "SWAP") return base;

  const legs = extractSwapLegs(tx);
  if (!legs) {
    // No genuine coin trade found for our wallet in this transaction - it's
    // usually because our address was just a minor pass-through/rebate
    // recipient in someone else's much bigger routed transaction (confirmed
    // on a real OKX DEX Router case: our wallet received a tiny incidental
    // USDC amount inside a swap that wasn't ours at all). Skip it entirely
    // rather than showing a noisy, meaningless card.
    return null;
  }

  const meta = await getTokenMeta(legs.mint);
  const priceUsd =
    legs.quoteValueUsd != null && legs.tokenAmount > 0 ? legs.quoteValueUsd / legs.tokenAmount : null;
  const supply = (meta && meta.supply) || null;
  const marketCapUsd = priceUsd != null && supply ? priceUsd * supply : null;

  return {
    ...base,
    direction: legs.direction,
    mint: legs.mint,
    symbol: (meta && meta.symbol) || null,
    supply,
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
      const filtered = newEvents.filter((e) => e !== null); // drop non-trades (see buildEvent)
      events = [...events, ...filtered];
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      saveJson(ACTIVITY_FILE, events);
      filtered.forEach(sendTelegramAlert);
      console.log(`[webhook] stored ${filtered.length} event(s) (${newEvents.length - filtered.length} skipped, no real trade)`);
    })
    .catch((e) => console.error("[error] processing webhook:", e));
});

app.get("/api/activity", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(events.slice(-limit).reverse());
});

// ---------- EVM webhook endpoint (Alchemy) ----------
// One endpoint handles all EVM chains - Alchemy's "Address Activity"
// webhook payload includes which network it came from.
//
// Important, confirmed on real captured data: Alchemy sends ONE webhook
// call per activity item, NOT one bundled call per transaction like Helius
// did for Solana. A single swap shows up as multiple separate deliveries
// (e.g. "0.0001 ETH out" and "0.966 TOKEN in" arrived as two different
// webhook calls, ~1 second apart, sharing the same transaction hash). We
// buffer activity items by hash for a few seconds so they can be
// recombined into one real trade before we compute anything.

const NETWORK_TO_CHAIN = {
  ROBINHOOD_MAINNET: "robinhood",
  ETH_MAINNET: "ethereum", // confirmed correct against real data
  BASE_MAINNET: "base", // confirmed correct against real data
  BNB_MAINNET: "bsc", // not yet verified against real data - confirm when BSC is added
};

const NATIVE_ETH = "NATIVE_ETH"; // sentinel id for the chain's native gas token
// Known "quote" assets, same concept as SOL/USDC on the Solana side. Only
// native ETH for now - add stablecoin contract addresses here as we
// encounter USDC/USDT/USDG-quoted swaps on these chains.
const EVM_QUOTE_IDS = new Set([NATIVE_ETH]);

function findWatchedEvmAddress(activities, chain) {
  const knownMap = {}; // lowercase address -> original-cased address (for label lookup)
  for (const [addr, info] of Object.entries(wallets)) {
    // "evm" means "watch this address on every EVM chain" - saves adding
    // the same address three times when it's the same wallet on all of them.
    if (info.chain === chain || info.chain === "evm") knownMap[addr.toLowerCase()] = addr;
  }
  for (const act of activities) {
    const from = act.fromAddress && act.fromAddress.toLowerCase();
    const to = act.toAddress && act.toAddress.toLowerCase();
    if (from && knownMap[from]) return knownMap[from];
    if (to && knownMap[to]) return knownMap[to];
  }
  return null;
}

// Net change per asset for our wallet, across every activity item that
// shares one transaction hash. Native ETH and each ERC-20 contract are
// tracked as separate "assets", identified by contract address (or the
// NATIVE_ETH sentinel).
function computeEvmNetFlows(activities, watchedAddressLower) {
  const net = {};
  const assetMeta = {}; // assetId -> { symbol }
  for (const act of activities) {
    const isToken = act.category === "token" && act.rawContract && act.rawContract.address;
    const assetId = isToken ? act.rawContract.address.toLowerCase() : NATIVE_ETH;
    assetMeta[assetId] = { symbol: act.asset || null };

    const amount = act.value || 0;
    const from = act.fromAddress && act.fromAddress.toLowerCase();
    const to = act.toAddress && act.toAddress.toLowerCase();
    if (to === watchedAddressLower) net[assetId] = (net[assetId] || 0) + amount;
    if (from === watchedAddressLower) net[assetId] = (net[assetId] || 0) - amount;
  }
  return { net, assetMeta };
}

// Which CoinGecko-tracked USD price applies to a chain's native gas token.
// Ethereum, Base, and Robinhood Chain all use ETH; BSC uses BNB.
function nativePriceUsdFor(chain) {
  return chain === "bsc" ? bnbUsdPrice : ethUsdPrice;
}

function extractEvmSwapLegs(activities, watchedAddressLower, chain) {
  const { net, assetMeta } = computeEvmNetFlows(activities, watchedAddressLower);

  let coinId = null;
  let coinAmount = 0;
  const quoteNet = {};
  for (const [id, amount] of Object.entries(net)) {
    if (Math.abs(amount) < 1e-12) continue; // dust/rounding noise
    if (EVM_QUOTE_IDS.has(id)) quoteNet[id] = amount;
    else if (Math.abs(amount) > Math.abs(coinAmount)) {
      coinId = id;
      coinAmount = amount;
    }
  }
  if (!coinId) return null; // no real coin movement for our wallet - e.g. pure fee/passthrough

  const nativePriceUsd = nativePriceUsdFor(chain);
  let quoteValueUsd = 0;
  let quoteSymbol = null;
  let quoteAmount = null;
  let dominantAbs = 0;
  for (const [id, amount] of Object.entries(quoteNet)) {
    const usdValue = id === NATIVE_ETH && nativePriceUsd ? amount * nativePriceUsd : null;
    if (usdValue != null) quoteValueUsd += usdValue;
    if (Math.abs(amount) > dominantAbs) {
      dominantAbs = Math.abs(amount);
      quoteSymbol = (assetMeta[id] && assetMeta[id].symbol) || (chain === "bsc" ? "BNB" : "ETH");
      quoteAmount = Math.abs(amount);
    }
  }

  const direction = coinAmount > 0 ? "BUY" : "SELL";
  // Common EVM spam pattern: an unsolicited token airdrop straight into the
  // wallet, with no native currency ever spent - a real buy always costs
  // something. Treat "received a token for $0" as spam, not a trade.
  if (direction === "BUY" && !quoteAmount) return null;

  return {
    direction,
    mint: coinId === NATIVE_ETH ? null : coinId, // contract address, lowercase
    symbol: (assetMeta[coinId] && assetMeta[coinId].symbol) || null,
    tokenAmount: Math.abs(coinAmount),
    quoteValueUsd: Math.abs(quoteValueUsd) || null,
    quoteSymbol,
    quoteAmount,
  };
}

const pendingEvmTx = {}; // hash -> { activities: [], chain, timer }
const EVM_GROUP_DELAY_MS = 3000; // wait this long after the last related delivery before processing

function scheduleEvmProcessing(hash) {
  const entry = pendingEvmTx[hash];
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => processEvmGroup(hash), EVM_GROUP_DELAY_MS);
}

function processEvmGroup(hash) {
  const entry = pendingEvmTx[hash];
  delete pendingEvmTx[hash];
  if (!entry) return;

  const { activities, chain } = entry;
  const watchedAddress = findWatchedEvmAddress(activities, chain);
  if (!watchedAddress) return; // shouldn't normally happen - Alchemy only sends activity for watched addresses

  const walletLabel = (wallets[watchedAddress] && wallets[watchedAddress].label) || null;
  const first = activities[0] || {};
  const timestamp = first.blockTimestamp ? parseInt(first.blockTimestamp, 16) * 1000 : Date.now();

  const legs = extractEvmSwapLegs(activities, watchedAddress.toLowerCase());
  if (!legs) return; // no real trade for our wallet in this tx - skip silently, same as the Solana OKX-router case

  const priceUsd =
    legs.quoteValueUsd != null && legs.tokenAmount > 0 ? legs.quoteValueUsd / legs.tokenAmount : null;

  const finalEvent = {
    id: hash,
    timestamp,
    walletAddress: watchedAddress,
    walletLabel,
    chain,
    type: "SWAP",
    description: "",
    direction: legs.direction,
    mint: legs.mint,
    symbol: legs.symbol,
    tokenAmount: legs.tokenAmount,
    quoteAmount: legs.quoteAmount,
    quoteSymbol: legs.quoteSymbol,
    quoteValueUsd: legs.quoteValueUsd,
    priceUsd,
  };

  events = [...events, finalEvent];
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  saveJson(ACTIVITY_FILE, events);
  sendTelegramAlert(finalEvent);
  console.log(`[webhook/evm] stored event for tx ${hash} (chain=${chain})`);
}

app.post("/webhook/evm", (req, res) => {
  if (WEBHOOK_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== WEBHOOK_SECRET) return res.status(403).send("forbidden");
  }
  res.status(200).send("ok");

  try {
    const network = req.body.event && req.body.event.network;
    const chain = NETWORK_TO_CHAIN[network] || network;
    const activities = (req.body.event && req.body.event.activity) || [];
    for (const act of activities) {
      const hash = act.hash;
      if (!hash) continue;
      if (!pendingEvmTx[hash]) pendingEvmTx[hash] = { activities: [], chain };
      pendingEvmTx[hash].activities.push(act);
      scheduleEvmProcessing(hash);
    }
  } catch (e) {
    console.error("[error] processing EVM webhook:", e);
  }
});

app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Wallet dashboard listening on port ${PORT}`);
});
