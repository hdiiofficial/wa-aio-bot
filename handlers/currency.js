const STABLECOINS = new Set(["USDT","USDC","BUSD","DAI","TUSD","FDUSD","USDP"]);

const FIAT_CURRENCIES = new Set([
    "USD","IDR","EUR","GBP","SGD","MYR","JPY","AUD","CNY","KRW","THB",
    "PHP","VND","INR","HKD","TWD","CHF","SEK","NOK","DKK","SAR","AED",
    "BRL","MXN","ZAR","TRY","PLN","CZK","HUF",
]);

let COINGECKO_MAP = {};
let CRYPTO_SYMBOLS = new Set();
let lastRefresh = 0;
const COINGECKO_TTL = 60 * 60 * 1000;

async function fetchJSON(url, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

export async function loadBinanceSymbols() {
    try {
        const [page1, page2] = await Promise.all([
            fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false", 12000),
            fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false", 12000),
        ]);
        const coins = [...(page1 || []), ...(page2 || [])];
        const map = {};
        const symbols = new Set();
        for (const coin of coins) {
            const sym = coin.symbol?.toUpperCase();
            if (!sym) continue;
            if (!map[sym]) { map[sym] = coin.id; symbols.add(sym); }
        }
        const stableIds = { USDT: "tether", USDC: "usd-coin", DAI: "dai", BUSD: "binance-usd" };
        for (const [sym, id] of Object.entries(stableIds)) {
            if (!map[sym]) { map[sym] = id; symbols.add(sym); }
        }
        COINGECKO_MAP = map;
        CRYPTO_SYMBOLS = symbols;
        lastRefresh = Date.now();
        console.log(`✅ Loaded ${symbols.size} crypto symbols`);
    } catch (e) {
        console.error("❌ Gagal load CoinGecko:", e.message);
    }
}

async function ensureSymbols() {
    if (CRYPTO_SYMBOLS.size === 0 || Date.now() - lastRefresh > COINGECKO_TTL) {
        await loadBinanceSymbols();
    }
}

function isFiat(sym) { return FIAT_CURRENCIES.has(sym.toUpperCase()); }
function isStable(sym) { return STABLECOINS.has(sym.toUpperCase()); }
function isCrypto(sym) { return CRYPTO_SYMBOLS.has(sym.toUpperCase()) || STABLECOINS.has(sym.toUpperCase()); }

async function getCryptoPriceUSD(symbol) {
    const up = symbol.toUpperCase();
    if (isStable(up)) return 1;
    const coinId = COINGECKO_MAP[up];
    if (!coinId) throw new Error(`${symbol} tidak ditemukan`);
    const data = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,idr`);
    const price = data[coinId]?.usd;
    if (!price) throw new Error(`Harga ${symbol} tidak tersedia`);
    return price;
}

async function getFiatRate(from, to) {
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from.toLowerCase()}.json`;
    const data = await fetchJSON(url);
    const rate = data[from.toLowerCase()]?.[to.toLowerCase()];
    if (!rate) throw new Error(`Konversi ${from} ke ${to} tidak tersedia`);
    return rate;
}

function finFmt(n) {
    if (n >= 1_000_000_000) return (n/1_000_000_000).toFixed(2) + "B";
    if (n >= 1_000_000)     return (n/1_000_000).toFixed(2) + "M";
    if (n >= 1_000)         return n.toLocaleString("id-ID");
    return n < 0.01 ? n.toFixed(8).replace(/0+$/, "") : n.toFixed(4).replace(/\.?0+$/, "");
}

const CONV_RE = /^([\d,.]+)\s+([a-zA-Z]{2,10})\s+(?:to|ke|→)\s+([a-zA-Z]{2,10})$/i;

export function isConversionMessage(text) { return CONV_RE.test(text.trim()); }

export async function convertCurrency(text) {
    const m = text.trim().match(CONV_RE);
    if (!m) return null;
    await ensureSymbols();

    const amount = parseFloat(m[1].replace(/[.,]/g, (c, i, s) => {
        const rest = s.slice(i + 1);
        return rest.length === 3 && !/[.,]/.test(rest) ? "" : ".";
    }));
    const from = m[2].toUpperCase();
    const to   = m[3].toUpperCase();

    let result;

    if (isFiat(from) && isFiat(to)) {
        const rate = await getFiatRate(from, to);
        result = amount * rate;
        return { text: `*${amount.toLocaleString()} ${from}* = *${finFmt(result)} ${to}*\n_sumber: fawazahmed0_` };
    }

    if (isCrypto(from) || isCrypto(to)) {
        const fromUSD = isFiat(from) ? 1 / await getFiatRate("USD", from) : await getCryptoPriceUSD(from);
        const toUSD   = isFiat(to)   ? 1 / await getFiatRate("USD", to)   : await getCryptoPriceUSD(to);
        result = amount * fromUSD / toUSD;
        return { text: `*${amount.toLocaleString()} ${from}* = *${finFmt(result)} ${to}*\n_sumber: CoinGecko_` };
    }

    throw new Error(`Currency tidak dikenal: ${from} atau ${to}`);
}

const PRICE_RE = /^([\d,.]+)?\s*([a-zA-Z]{2,10})(?:\s+(price|harga|ke|to|usd|idr))?$/i;

export async function isPriceCheckMessage(text) {
    await ensureSymbols();
    const m = text.trim().match(PRICE_RE);
    if (!m) return false;
    const sym = m[2].toUpperCase();
    return isCrypto(sym);
}

export async function checkPrice(text) {
    await ensureSymbols();
    const m = text.trim().match(PRICE_RE);
    if (!m) return null;
    const sym = m[2].toUpperCase();
    if (!isCrypto(sym)) return null;

    const usd = await getCryptoPriceUSD(sym);
    const idrRate = await getFiatRate("USD", "IDR").catch(() => 15800);
    const idr = usd * idrRate;
    const amt = m[1] ? parseFloat(m[1].replace(/[.,]/g, "")) : 1;

    return {
        text: `*${amt} ${sym}*\nUSD : $${finFmt(usd * amt)}\nIDR : Rp${finFmt(idr * amt)}\n_CoinGecko_`
    };
}

export async function getExchangeRate(from, to) {
    await ensureSymbols();
    const f = from.toLowerCase();
    const t = to.toLowerCase();

    if (isFiat(from.toUpperCase()) && isFiat(to.toUpperCase())) {
        const rate = await getFiatRate(f, t);
        return { from: f, to: t, rate, fromName: from.toUpperCase(), toName: to.toUpperCase() };
    }

    const fromUSD = isFiat(from.toUpperCase()) ? 1 / await getFiatRate("USD", from.toUpperCase()) : await getCryptoPriceUSD(from);
    const toUSD   = isFiat(to.toUpperCase())   ? 1 / await getFiatRate("USD", to.toUpperCase())   : await getCryptoPriceUSD(to);
    const rate    = fromUSD / toUSD;
    return { from: f, to: t, rate, fromName: from.toUpperCase(), toName: to.toUpperCase() };
}

export async function getCryptoPrice(symbol) {
    await ensureSymbols();
    const up  = symbol.toUpperCase();
    const usd = await getCryptoPriceUSD(up);
    const idrRate = await getFiatRate("USD", "IDR").catch(() => 15800);
    const idr     = usd * idrRate;
    return { symbol: up, usd, idr, change: 0 };
}
