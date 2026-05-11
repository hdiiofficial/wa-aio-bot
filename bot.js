/**
 * WA All-In-One Bot
 * Fitur: Download video/audio, Stiker, Math, Currency/Crypto, Wikipedia
 */

import {
    default as makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import http from "http";

import { isMathExpression, evaluateMath, safeEval } from "./handlers/math.js";
import { isConversionMessage, convertCurrency, isPriceCheckMessage, checkPrice, loadBinanceSymbols, getExchangeRate, getCryptoPrice } from "./handlers/currency.js";
import { downloadVideo, downloadAudio, detectPlatform, fmtSize, cleanFile, extractThumbnail, getVideoTitle } from "./handlers/downloader.js";
import { searchWiki } from "./handlers/wiki.js";
import { makeSticker } from "./handlers/image.js";
import { generateQR } from "./handlers/qr.js";

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));

const OWNER_PHONE = process.env.OWNER_PHONE || "62895401509576";
const SESSION_DIR = path.join(__dirname, "session");
const DATA_DIR    = path.join(__dirname, "data");

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR,    { recursive: true });

const logger = pino({ level: "silent" });

function normalizePhone(raw) {
    if (!raw) return null;
    let p = String(raw).replace(/\D/g, "");
    if (p.startsWith("0")) p = "62" + p.slice(1);
    if (!p.startsWith("62")) p = "62" + p;
    if (p.length < 10 || p.length > 15) return null;
    return p;
}

// ── Auto-update yt-dlp ───────────────────────────────────────────────────────
async function updateYtDlp() {
    const dest = "/tmp/yt-dlp";
    if (fs.existsSync(dest)) {
        try {
            const { stdout } = await execFileAsync(dest, ["--version"], { timeout:5_000 });
            process.env.YTDLP_BIN = dest;
            console.log(`✅ yt-dlp ${stdout.trim()} (cached)`);
            return;
        } catch (_) {}
    }
    console.log("🔄 Mengunduh yt-dlp terbaru...");
    function dlUrl(url, filePath, redirects = 8) {
        return new Promise((resolve, reject) => {
            if (redirects < 0) return reject(new Error("too many redirects"));
            const proto = url.startsWith("https") ? https : http;
            const file  = fs.createWriteStream(filePath);
            proto.get(url, { headers:{ "User-Agent":"Mozilla/5.0" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close(); try { fs.unlinkSync(filePath); } catch(_) {}
                    return dlUrl(res.headers.location, filePath, redirects-1).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) { file.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                res.pipe(file);
                file.on("finish", () => file.close(resolve));
                file.on("error", reject);
            }).on("error", reject);
        });
    }
    try {
        await dlUrl("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux", dest);
        fs.chmodSync(dest, 0o755);
        const { stdout } = await execFileAsync(dest, ["--version"], { timeout:10_000 });
        process.env.YTDLP_BIN = dest;
        console.log(`✅ yt-dlp ${stdout.trim()} (fresh)`);
    } catch (e) {
        console.log(`⚠️  yt-dlp download gagal: ${e.message?.slice(0,60)}`);
    }
}

const BAR_LEN = 10;
function renderBar(pct) {
    const filled = Math.round((pct/100)*BAR_LEN);
    return `${"▓".repeat(filled)}${"░".repeat(BAR_LEN-filled)} ${pct}%\n_sedang memproses..._`;
}

// ── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(sock, jid, msg) {
    const body  = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || "";
    const lower = body.toLowerCase().trim();

    async function reply(text) { return sock.sendMessage(jid, { text }, { quoted: msg }); }
    async function react(emoji) { return sock.sendMessage(jid, { react:{ text:emoji, key:msg.key } }); }

    // ── .menu ─────────────────────────────────────────────────────────────────
    if (lower === ".menu" || lower === ".help" || lower === ".start") {
        await reply(
`── WA All-In-One Bot ────────────────
*Download Video*
  Kirim link langsung → auto download
  Platform: YouTube, TikTok, Instagram, Facebook, Twitter/X, Reddit, dll

*Download Audio*
  *.mp3 [link]* → download MP3

*Stiker*
  *.stiker* (balas gambar/video) → buat stiker
  *.stiker [TEKS]* → stiker dengan teks

*Kalkulator*
  *.hitung [ekspresi]*
  Atau ketik rumus langsung, contoh: _15000 * 30_

*Kurs & Crypto*
  *.kurs [dari] [ke]* — contoh: _.kurs usd idr_
  *.crypto [koin]* — contoh: _.crypto btc_
  Atau ketik: _1 btc to idr_ / _100 usd to idr_

*Wikipedia*
  *.wiki [topik]*

*QR Code*
  *.qr [teks/link]*
────────────────────────────────────`
        );
        return;
    }

    // ── .stiker ───────────────────────────────────────────────────────────────
    if (lower.startsWith(".stiker") || lower.startsWith(".sticker")) {
        const textOverlay = body.split(/\s+/).slice(1).join(" ").trim();
        const quotedMsg   = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imgMsg      = msg.message?.imageMessage || quotedMsg?.imageMessage;
        const vidMsg      = msg.message?.videoMessage || quotedMsg?.videoMessage;

        if (!imgMsg && !vidMsg) {
            await reply("Balas gambar/video dengan *.stiker*\n\nContoh:\n  *.stiker* → stiker biasa\n  *.stiker NGAKAK* → stiker + teks");
            return;
        }
        await react("⏳");
        try {
            let buffer;
            if (imgMsg) {
                const stream = await downloadContentFromMessage(imgMsg, "image");
                const chunks = [];
                for await (const chunk of stream) chunks.push(chunk);
                buffer = Buffer.concat(chunks);
            } else {
                const stream = await downloadContentFromMessage(vidMsg, "video");
                const chunks = [];
                for await (const chunk of stream) chunks.push(chunk);
                const tmpIn  = `/tmp/stk_${Date.now()}.mp4`;
                const tmpOut = `/tmp/stk_${Date.now()}.jpg`;
                fs.writeFileSync(tmpIn, Buffer.concat(chunks));
                await execFileAsync("ffmpeg", ["-y","-i",tmpIn,"-ss","00:00:01","-vframes","1",tmpOut], { timeout:15_000 });
                buffer = fs.readFileSync(tmpOut);
                try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch(_) {}
            }
            const stickerBuf = await makeSticker(buffer, textOverlay);
            await sock.sendMessage(jid, { sticker: stickerBuf }, { quoted: msg });
            await react("✅");
        } catch (e) {
            await reply(`Gagal buat stiker: ${e.message}`);
            await react("❌");
        }
        return;
    }

    // ── .wiki ─────────────────────────────────────────────────────────────────
    if (lower.startsWith(".wiki ") || lower === ".wiki") {
        const q = body.slice(5).trim();
        if (!q) { await reply("Format: *.wiki [topik]*\nContoh: _.wiki Soekarno_"); return; }
        await react("⏳");
        try {
            const w = await searchWiki(q);
            await reply(`*${w.title}*\n\n${w.extract}\n\n${w.url}`);
            await react("✅");
        } catch (e) { await reply(e.message); await react("❌"); }
        return;
    }

    // ── .hitung ───────────────────────────────────────────────────────────────
    if (lower.startsWith(".hitung ")) {
        const expr   = body.slice(8).trim();
        const result = safeEval(expr);
        if (result === null || isNaN(result)) {
            await reply("Ekspresi tidak valid\nContoh: _.hitung 150000 * 12_");
        } else {
            await reply(`*${expr}*\n= *${new Intl.NumberFormat("id-ID").format(result)}*`);
        }
        return;
    }

    // ── .kurs ─────────────────────────────────────────────────────────────────
    if (lower.startsWith(".kurs")) {
        const parts = lower.slice(5).trim().split(/\s+/);
        const from  = parts[0] || "usd";
        const to    = parts[1] || "idr";
        await react("⏳");
        try {
            const r    = await getExchangeRate(from, to);
            const rate = r.rate >= 1000
                ? r.rate.toLocaleString("id-ID", { maximumFractionDigits:2 })
                : r.rate >= 1 ? r.rate.toFixed(4).replace(/\.?0+$/,"") : r.rate.toFixed(6).replace(/\.?0+$/,"");
            await reply(`── kurs ${r.from.toUpperCase()} → ${r.to.toUpperCase()} ──────────────\n1 ${r.from.toUpperCase()} = *${rate} ${r.to.toUpperCase()}*\n_realtime_`);
            await react("✅");
        } catch (e) { await reply(e.message); await react("❌"); }
        return;
    }

    // ── .crypto ───────────────────────────────────────────────────────────────
    if (lower.startsWith(".crypto ")) {
        const symbol = lower.slice(8).trim();
        await react("⏳");
        try {
            const c = await getCryptoPrice(symbol);
            await reply(
                `── ${c.symbol} ─────────────────────────────\n` +
                `USD : $${c.usd.toLocaleString("en-US",{maximumFractionDigits:8})}\n` +
                `IDR : Rp${c.idr.toLocaleString("id-ID",{maximumFractionDigits:0})}\n` +
                `_CoinGecko_`
            );
            await react("✅");
        } catch (e) { await reply(e.message); await react("❌"); }
        return;
    }

    // ── .qr ───────────────────────────────────────────────────────────────────
    if (lower.startsWith(".qr ")) {
        const text = body.slice(4).trim();
        if (!text) { await reply("Format: *.qr [teks/link]*"); return; }
        await react("⏳");
        try {
            const buf = await generateQR(text);
            await sock.sendMessage(jid, { image:buf, caption:`QR: _${text}_` }, { quoted:msg });
            await react("✅");
        } catch (e) { await reply(`Gagal: ${e.message}`); await react("❌"); }
        return;
    }

    // ── .mp3 ─────────────────────────────────────────────────────────────────
    if (lower.startsWith(".mp3")) {
        const urlMatch = body.match(/https?:\/\/[^\s]+/i);
        if (!urlMatch) { await reply("Format: *.mp3 [link]*\nContoh: _.mp3 https://youtu.be/xxx_"); return; }
        const url = urlMatch[0];
        let result;
        try {
            result = await downloadAudio(url);
            await sock.sendMessage(jid, { audio:{ url:result.file }, mimetype:"audio/mpeg", ptt:false }, { quoted:msg });
        } catch (e) {
            await reply(`Gagal download audio:\n${e.message?.slice(0,200)}`);
        } finally { if (result?.file) cleanFile(result.file); }
        return;
    }

    // ── Auto-download video dari link ─────────────────────────────────────────
    const URL_RE     = /https?:\/\/[^\s]+/i;
    const TG_LINK_RE = /https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i;
    const hasUrl     = URL_RE.test(body);

    if (hasUrl && !lower.startsWith(".")) {
        const url = body.match(URL_RE)[0];
        if (TG_LINK_RE.test(url)) return;
        const platform = detectPlatform(url);
        if (platform.name === "Website") return;

        // URL lock: cegah video dikirim dobel
        if (_downloadingUrls.has(url)) return;
        _downloadingUrls.add(url);

        // Kirim pesan tunggu, lalu video nyusul tanpa quoted
          await react("⏳");

          let result = null, thumbFile = null;

        try {
            result = await downloadVideo(url);
            let title = result.title || "";
            if (!title) { try { title = await getVideoTitle(url); } catch(_) {} }
            if (!title) title = platform.name + " Video";
            thumbFile = await extractThumbnail(result.file);
            await sock.sendMessage(jid, {
                video    : fs.readFileSync(result.file),
                mimetype : "video/mp4",
                caption  : `*${title}*\n${fmtSize(result.size)}`,
                ...(thumbFile ? { jpegThumbnail:fs.readFileSync(thumbFile) } : {}),
            }, { quoted: msg });
            await react("✅");
  } catch (e) {
            await react("❌");
            const hint = e.message?.includes("terlalu besar") ? "\n_coba .mp3 [link] untuk audio_" : "";
            await reply(`Gagal download:\n${e.message?.slice(0,200)}${hint}`);
        } finally {
            _downloadingUrls.delete(url);
            if (result?.file) cleanFile(result.file);
            if (thumbFile) cleanFile(thumbFile);
        }
        return;
    }

    // ── Auto math ────────────────────────────────────────────────────────────
    if (!hasUrl && !lower.startsWith(".") && isMathExpression(body)) {
        const res = evaluateMath(body);
        if (res) await reply(`${res.expr} = ${res.result}`);
        return;
    }

    // ── Auto currency/crypto conversion ───────────────────────────────────────
    if (!hasUrl && !lower.startsWith(".") && isConversionMessage(body)) {
        try {
            const res = await convertCurrency(body);
            if (res) await reply(res.text);
        } catch (_) {}
        return;
    }

    if (!hasUrl && !lower.startsWith(".") && await isPriceCheckMessage(body).catch(()=>false)) {
        try {
            const res = await checkPrice(body);
            if (res) await reply(res.text);
        } catch (_) {}
        return;
    }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
let _sock = null;
const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.json({ status:"WA Bot", paired:!!(_sock?.authState?.creds?.registered), uptime:process.uptime() }));

app.get("/pair", async (req, res) => {
    if (!_sock) return res.status(503).json({ error:"Bot belum siap" });
    if (_sock.authState?.creds?.registered) return res.status(400).json({ error:"Sudah paired" });
    const phone = normalizePhone(req.query.phone || OWNER_PHONE);
    if (!phone) return res.status(400).json({ error:"Nomor tidak valid" });
    try {
        const code = await _sock.requestPairingCode(phone);
        console.log(`\n📱 Pairing Code: ${code} (${phone})`);
        res.json({ phone, code, petunjuk:"Buka WA → Perangkat Tertaut → Tautkan dengan Nomor HP" });
    } catch (e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, () => console.log(`🌐 HTTP server aktif di port ${PORT}`));

// ── WA Connection ─────────────────────────────────────────────────────────────
const msgRetryCounterCache = { _m:new Map(), get(k){return this._m.get(k);}, set(k,v){this._m.set(k,v);} };
let _pairingDone    = false;
let _logoutRetries  = 0;
const _downloadingUrls = new Set();

function resetPairingState() { _pairingDone = false; }

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, logger,
        auth: { creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys, logger) },
        browser              : ["Mac OS", "Chrome", "14.4.1"],
        printQRInTerminal    : false,
        syncFullHistory      : false,
        markOnlineOnConnect  : true,
        mobile               : false,
        msgRetryCounterCache,
        connectTimeoutMs     : 60_000,
        keepAliveIntervalMs  : 10_000,
        emitOwnEvents        : true,
        fireInitQueries      : true,
    });

    _sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr && !sock.authState.creds.registered && !_pairingDone) {
            _pairingDone = true;
            const phone  = normalizePhone(OWNER_PHONE);
            if (!phone) { console.error("❌ OWNER_PHONE tidak valid!"); return; }
            try {
                const code = await sock.requestPairingCode(phone);
                console.log("\n╔══════════════════════════════════════╗");
                console.log(`║  📱 PAIRING CODE: ${code.padEnd(16)} ║`);
                console.log("╚══════════════════════════════════════╝");
                console.log(`Nomor: ${phone}`);
                console.log("Buka WA → Perangkat Tertaut → Tautkan dengan Nomor HP\n");
            } catch (e) { console.error("❌ Gagal request pairing code:", e.message); _pairingDone = false; }
        }
        if (connection === "open") {
            _logoutRetries = 0;
            resetPairingState();
            console.log("✅ WA Bot aktif!\n");
        }
        if (connection === "close") {
            _sock = null;
            const errCode = lastDisconnect?.error?.output?.statusCode;
            if (errCode === DisconnectReason.loggedOut) {
                _logoutRetries++;
                resetPairingState();
                // Hapus ISI folder session (bukan foldernya — volume mount tidak bisa di-rmSync)
                try {
                    for (const f of fs.readdirSync(SESSION_DIR)) {
                        fs.rmSync(path.join(SESSION_DIR, f), { recursive:true, force:true });
                    }
                } catch(_) {}
                // Exponential backoff: 3s → 6s → 12s → 24s → max 60s
                const delay = Math.min(3000 * Math.pow(2, _logoutRetries - 1), 60000);
                console.log(`⏰ Session invalid/expired (ke-${_logoutRetries}), retry dalam ${delay/1000}s...`);
                setTimeout(startBot, delay);
                return;
            }
            console.log("↩️ Reconnecting...");
            setTimeout(startBot, 5000);
        }
    });

    const _seen = new Set();
    const _proc = new Set();
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const msgId = msg.key.id;
            if (!msgId || _seen.has(msgId) || _proc.has(msgId)) continue;
            _seen.add(msgId);
            _proc.add(msgId);
            if (_seen.size > 500) { const first = _seen.values().next().value; _seen.delete(first); }
            try { await handleMessage(sock, msg.key.remoteJid, msg); }
            catch (e) { console.error(`Handler error: ${e.message}`); }
            finally { _proc.delete(msgId); }
        }
    });
}

console.log("\n🤖 WA All-In-One Bot");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`📱 Nomor: ${OWNER_PHONE}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

(async () => {
    await updateYtDlp();
    console.log("⏳ Loading crypto symbols...");
    await loadBinanceSymbols();
    setInterval(loadBinanceSymbols, 60*60*1000);
    await startBot();
})().catch(err => { console.error("Fatal:", err.message); process.exit(1); });

process.once("SIGINT",  () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
