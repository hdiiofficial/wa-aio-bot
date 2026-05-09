/**
 * Downloader — sama persis dengan bot Telegram
 *
 * TikTok    → @tobyg74/tiktok-api-dl v3 | fallback: TikWM | fallback: SnapTik
 * Instagram → yt-dlp
 * YouTube   → play-dl primary | fallback: yt-dlp
 * Facebook  → yt-dlp | fallback: SnapSave
 * Twitter/X → yt-dlp | fallback: fxtwitter API
 * Generic   → yt-dlp universal
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import playdl from "play-dl";

const execFileAsync = promisify(execFile);

class PlatformQueue {
    constructor(cooldownMs = 1500) { this.queue=[]; this.running=false; this.cooldownMs=cooldownMs; }
    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._run();
        });
    }
    async _run() {
        if (this.running) return;
        this.running = true;
        while (this.queue.length) {
            const { fn, resolve, reject } = this.queue.shift();
            try   { resolve(await fn()); }
            catch (e) { reject(e); }
            if (this.queue.length) await new Promise(r => setTimeout(r, this.cooldownMs));
        }
        this.running = false;
    }
}

const queues = {
    tiktok   : new PlatformQueue(2000),
    instagram: new PlatformQueue(2000),
    youtube  : new PlatformQueue(2500),
    facebook : new PlatformQueue(2000),
    twitter  : new PlatformQueue(1500),
    generic  : new PlatformQueue(1500),
};

const urlCache  = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(url) {
    const hit = urlCache.get(url);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL) { urlCache.delete(url); return null; }
    if (!fs.existsSync(hit.result.file)) { urlCache.delete(url); return null; }
    return hit.result;
}
function cacheSet(url, result) { urlCache.set(url, { result, ts: Date.now() }); }

const TMP = "/tmp/wa_aio";
fs.mkdirSync(TMP, { recursive: true });

export function tmpFile(ext) {
    return path.join(TMP, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}
export function cleanFile(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
}
export function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/(1024*1024)).toFixed(2)} MB`;
}

export const PLATFORM_MAP = [
    { re:/youtube\.com|youtu\.be/i,           name:"YouTube",     emoji:"🎬", key:"youtube"   },
    { re:/tiktok\.com/i,                       name:"TikTok",      emoji:"🎵", key:"tiktok"   },
    { re:/instagram\.com/i,                   name:"Instagram",   emoji:"📸", key:"instagram" },
    { re:/twitter\.com|x\.com/i,              name:"Twitter/X",   emoji:"🐦", key:"twitter"  },
    { re:/facebook\.com|fb\.com|fb\.watch/i,  name:"Facebook",    emoji:"👥", key:"facebook" },
    { re:/pinterest\.com/i,                   name:"Pinterest",   emoji:"📌", key:"generic"  },
    { re:/reddit\.com/i,                      name:"Reddit",      emoji:"🤖", key:"generic"  },
    { re:/dailymotion\.com/i,                 name:"Dailymotion", emoji:"🎞️", key:"generic"  },
    { re:/vimeo\.com/i,                       name:"Vimeo",       emoji:"🎥", key:"generic"  },
];

export function detectPlatform(url) {
    for (const p of PLATFORM_MAP) if (p.re.test(url)) return p;
    return { name:"Website", emoji:"🌐", key:"generic" };
}

function getCookiesArgs() {
    const f = process.env.YTDLP_COOKIES_FILE;
    if (f && fs.existsSync(f)) return ["--cookies", f];
    return [];
}

function getYtDlpBin() { return process.env.YTDLP_BIN || "yt-dlp"; }

// ── HTTP downloader dengan redirect ─────────────────────────────────────────
function downloadFromUrl(url, dest, redirects = 10, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        if (redirects < 0) return reject(new Error("too many redirects"));
        const proto = url.startsWith("https") ? https : http;
        const file  = fs.createWriteStream(dest);
        proto.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept"    : "video/mp4,video/*;q=0.9,*/*;q=0.8",
                ...extraHeaders,
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(dest); } catch (_) {}
                return downloadFromUrl(res.headers.location, dest, redirects-1, extraHeaders).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { file.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            res.pipe(file);
            file.on("finish", () => file.close(resolve));
            file.on("error", reject);
        }).on("error", (err) => { try { fs.unlinkSync(dest); } catch(_) {} reject(err); });
    });
}

// ── yt-dlp core ─────────────────────────────────────────────────────────────
async function downloadWithYtDlp(url, extraArgs = []) {
    const prefix  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outTmpl = path.join(TMP, `${prefix}.%(ext)s`);
    const args    = [
        "--no-playlist", "--socket-timeout", "30", "--retries", "3",
        "-f", "bestvideo[ext=mp4][vcodec!*=av01]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/mp4/best",
        "--merge-output-format", "mp4",
        "-o", outTmpl,
        ...getCookiesArgs(), ...extraArgs, url,
    ];
    const { stderr } = await execFileAsync(getYtDlpBin(), args, { timeout:120_000, maxBuffer:20*1024*1024 }).catch(err => { throw new Error((err.stderr || err.message || "").slice(0,400)); });
    const files = fs.readdirSync(TMP).filter(f => f.startsWith(prefix)).map(f => path.join(TMP, f));
    if (!files.length) throw new Error("yt-dlp: tidak ada output");
    const stat = fs.statSync(files[0]);
    if (stat.size === 0) throw new Error("yt-dlp: file kosong");
    return { file:files[0], size:stat.size, ext:path.extname(files[0]).slice(1)||"mp4", isImage:false };
}

async function isValidVideo(filePath) {
    try {
        if (fs.statSync(filePath).size < 10_000) return false;
        const { stdout } = await execFileAsync("ffprobe", ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",filePath], { timeout:15_000 });
        const s = JSON.parse(stdout||"{}").streams?.[0];
        return s && parseInt(s.width||0) > 0;
    } catch (_) { return true; }
}

async function isAudioUrl(url) {
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, { method:"HEAD", signal:ctrl.signal, headers:{ "User-Agent":"Mozilla/5.0", "Referer":"https://www.tiktok.com/" } });
        const ct  = res.headers.get("content-type") || "";
        return ct.includes("audio") && !ct.includes("video");
    } catch (_) { return false; }
}

// ── TikTok Slideshow → video via ffmpeg ─────────────────────────────────────
async function buildSlideshowVideo(d) {
    const images = Array.isArray(d.images) ? d.images : [];
    if (!images.length) throw new Error("Slideshow: tidak ada foto");
    const audioUrl = d.music || d.play;
    const imgFiles = [];

    for (let i = 0; i < images.length; i++) {
        const imgUrl = typeof images[i] === "string" ? images[i] : images[i]?.url || images[i]?.download_url;
        if (!imgUrl) continue;
        const dest = path.join(TMP, `${Date.now()}_slide${i}.jpg`);
        try {
            await downloadFromUrl(imgUrl, dest, 8, { "Referer":"https://www.tiktok.com/" });
            if (fs.statSync(dest).size > 1000) imgFiles.push(dest);
            else cleanFile(dest);
        } catch (_) {}
    }
    if (!imgFiles.length) throw new Error("Slideshow: semua foto gagal");

    const audioFile = path.join(TMP, `${Date.now()}_aud.mp3`);
    let hasAudio = false;
    if (audioUrl) {
        try {
            await downloadFromUrl(audioUrl, audioFile, 8, { "Referer":"https://www.tiktok.com/" });
            hasAudio = fs.statSync(audioFile).size > 1000;
        } catch (_) {}
    }

    const PER_SLIDE = 3;
    const totalDur  = imgFiles.length * PER_SLIDE;
    const listPath  = path.join(TMP, `${Date.now()}_list.txt`);
    const lines     = imgFiles.map(f => `file '${f}'\nduration ${PER_SLIDE}`);
    lines.push(`file '${imgFiles[imgFiles.length-1]}'`);
    fs.writeFileSync(listPath, lines.join("\n"));

    const outFile = path.join(TMP, `${Date.now()}_slideshow.mp4`);
    const ffArgs  = ["-y","-f","concat","-safe","0","-i",listPath];
    if (hasAudio) ffArgs.push("-stream_loop","-1","-i",audioFile);
    ffArgs.push("-vf","scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24","-c:v","libx264","-pix_fmt","yuv420p","-preset","fast","-t",String(totalDur));
    if (hasAudio) ffArgs.push("-c:a","aac","-b:a","128k");
    ffArgs.push(outFile);

    try {
        await execFileAsync("ffmpeg", ffArgs, { timeout:120_000, maxBuffer:50*1024*1024 });
    } finally {
        imgFiles.forEach(f => cleanFile(f));
        cleanFile(listPath, audioFile);
    }
    const stat = fs.statSync(outFile);
    if (stat.size < 10_000) throw new Error("Slideshow: output kosong");
    return { file:outFile, size:stat.size, ext:"mp4", isImage:false, title:(d.title||"TikTok Slideshow").slice(0,80) };
}

// ── TikTok: @tobyg74 primary → TikWM fallback → SnapTik fallback ─────────────
let _tiktokDL = null;
async function getTiktokDL() {
    if (_tiktokDL) return _tiktokDL;
    const m = await import("@tobyg74/tiktok-api-dl");
    _tiktokDL = m.Downloader || m.default?.Downloader;
    return _tiktokDL;
}

async function downloadTikTokViaTobyg74(url) {
    const Downloader = await getTiktokDL();
    if (typeof Downloader !== "function") throw new Error("tobyg74: Downloader bukan function");
    const result = await Downloader(url, { version:"v3" });
    if (result?.status !== "success") throw new Error(`tobyg74: status ${result?.status}`);
    const r = result.result;
    if (!r) throw new Error("tobyg74: result kosong");

    if (r.type === "image" && Array.isArray(r.images) && r.images.length > 0) {
        return await buildSlideshowVideo({
            images: r.images.map(i => typeof i === "string" ? i : i?.url || i?.download_url),
            music : r.music?.play_url || null,
            title : r.desc || "",
        });
    }

    const candidates = [r.videoHD, r.videoSD].filter(Boolean);
    if (!candidates.length) throw new Error("tobyg74: tidak ada URL video");
    for (const videoUrl of candidates) {
        try {
            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, { "Referer":"https://www.tiktok.com/" });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000) { cleanFile(dest); continue; }
            if (!await isValidVideo(dest)) { cleanFile(dest); continue; }
            console.log(`✅ TikTok via @tobyg74 (${videoUrl === r.videoHD ? "HD":"SD"})`);
            return { file:dest, size:stat.size, ext:"mp4", isImage:false, title:(r.desc||"").slice(0,80)||null };
        } catch (e) { console.log(`⚠️  tobyg74 url gagal: ${e.message?.slice(0,60)}`); }
    }
    throw new Error("tobyg74: semua URL gagal");
}

async function downloadTikTokViaTikWM(url) {
    const res  = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: { "User-Agent":"Mozilla/5.0", "Referer":"https://www.tikwm.com/", "Accept":"application/json" },
    });
    const data = await res.json();
    if (!data?.data) throw new Error("TikWM: respons kosong");
    const d = data.data;
    if (Array.isArray(d.images) && d.images.length > 0) return await buildSlideshowVideo(d);
    if (!d.play && !d.wmplay) throw new Error("TikWM: tidak ada URL video");
    for (const videoUrl of [d.play, d.wmplay].filter(Boolean)) {
        try {
            if (await isAudioUrl(videoUrl)) continue;
            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, { "Referer":"https://www.tiktok.com/" });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000 || !await isValidVideo(dest)) { cleanFile(dest); continue; }
            console.log("✅ TikTok via TikWM");
            return { file:dest, size:stat.size, ext:"mp4", isImage:false, title:(d.title||"").slice(0,80)||null };
        } catch (_) {}
    }
    throw new Error("TikWM: semua URL gagal");
}

async function downloadTikTokViaSnapTik(url) {
    const res  = await fetch("https://snaptik.app/abc2.php", {
        method:"POST",
        headers:{ "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"Mozilla/5.0", "Referer":"https://snaptik.app/" },
        body:`url=${encodeURIComponent(url)}`,
    });
    const html    = await res.text();
    const matches = [...html.matchAll(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/gi)];
    if (!matches.length) throw new Error("SnapTik: tidak ada URL");
    for (const m of matches.slice(0,3)) {
        try {
            const videoUrl = m[0].replace(/&amp;/g,"&");
            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, { "Referer":"https://snaptik.app/" });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000 || !await isValidVideo(dest)) { cleanFile(dest); continue; }
            console.log("✅ TikTok via SnapTik");
            return { file:dest, size:stat.size, ext:"mp4", isImage:false };
        } catch (_) {}
    }
    throw new Error("SnapTik: semua URL gagal");
}

async function downloadTikTok(url) {
    try { return await downloadTikTokViaTobyg74(url); }
    catch (e) { console.log(`⚠️  tobyg74 gagal (${e.message?.slice(0,80)}), fallback TikWM…`); }
    try { return await downloadTikTokViaTikWM(url); }
    catch (e) { console.log(`⚠️  TikWM gagal (${e.message?.slice(0,80)}), fallback SnapTik…`); }
    return await downloadTikTokViaSnapTik(url);
}

// ── Instagram → yt-dlp ───────────────────────────────────────────────────────
async function downloadInstagram(url) {
    return await downloadWithYtDlp(url);
}

// ── YouTube → play-dl primary + yt-dlp fallback ──────────────────────────────
function normalizeYTUrl(url) {
    const shorts = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;
    const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (short) return `https://www.youtube.com/watch?v=${short[1]}`;
    return url;
}

async function downloadYouTube(url) {
    const normalUrl = normalizeYTUrl(url);
    try {
        const info = await playdl.video_info(normalUrl);
        if (info?.format?.length) {
            const mp4    = info.format.filter(f => f.url && f.mimeType?.includes("mp4"));
            const picked = mp4.find(f => f.quality?.includes("360")) || mp4.find(f => f.quality?.includes("480")) || mp4[0] || info.format.filter(f => f.url)[0];
            if (picked?.url) {
                const dest = path.join(TMP, `${Date.now()}.mp4`);
                await downloadFromUrl(picked.url, dest);
                const stat = fs.statSync(dest);
                if (stat.size > 0) { console.log("✅ YouTube via play-dl"); return { file:dest, size:stat.size, ext:"mp4", isImage:false }; }
            }
        }
    } catch (e) { console.log(`⚠️  YouTube play-dl gagal (${e.message?.slice(0,60)}), fallback yt-dlp…`); }
    return await downloadWithYtDlp(normalUrl);
}

// ── Facebook → yt-dlp + SnapSave fallback ────────────────────────────────────
async function downloadFacebook(url) {
    try { return await downloadWithYtDlp(url); }
    catch (e) { console.log(`⚠️  Facebook yt-dlp gagal, coba SnapSave…`); }
    try {
        const apiRes = await fetch("https://snapsave.app/action.php", {
            method:"POST",
            headers:{ "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"Mozilla/5.0", "Referer":"https://snapsave.app/", "Origin":"https://snapsave.app" },
            body:`url=${encodeURIComponent(url)}`,
            signal:AbortSignal.timeout(20_000),
        });
        const html     = await apiRes.text();
        const videoUrl = html.match(/href="(https:\/\/[^"]+)"[^>]*>[\s\S]{0,50}?HD/i)?.[1]
            || html.match(/href="(https:\/\/[^"]*\.mp4[^"]*)"/i)?.[1];
        if (!videoUrl) throw new Error("SnapSave: tidak ada URL");
        const dest = path.join(TMP, `${Date.now()}_fb.mp4`);
        await downloadFromUrl(decodeURIComponent(videoUrl), dest);
        const stat = fs.statSync(dest);
        if (stat.size < 10_000) throw new Error("SnapSave: file terlalu kecil");
        console.log("✅ Facebook via SnapSave");
        return { file:dest, size:stat.size, ext:"mp4", isImage:false };
    } catch (e) { throw new Error(`Facebook gagal: ${e.message?.slice(0,80)}`); }
}

// ── Twitter/X → yt-dlp + fxtwitter fallback ──────────────────────────────────
async function downloadTwitter(url) {
    try { return await downloadWithYtDlp(url); }
    catch (e) { console.log(`⚠️  Twitter yt-dlp gagal, coba fxtwitter…`); }
    const tweetId = url.match(/status\/(\d+)/)?.[1];
    if (!tweetId) throw new Error("Twitter: tweet ID tidak ditemukan");
    const res  = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, { headers:{ "User-Agent":"Mozilla/5.0" } });
    const data = await res.json();
    const media    = data?.tweet?.media?.videos?.[0] || data?.tweet?.media?.photos?.[0];
    if (!media?.url) throw new Error("fxtwitter: tidak ada media");
    const isImg = !data?.tweet?.media?.videos?.[0];
    const ext   = isImg ? "jpg" : "mp4";
    const dest  = path.join(TMP, `${Date.now()}.${ext}`);
    await downloadFromUrl(media.url, dest);
    const stat  = fs.statSync(dest);
    if (stat.size === 0) throw new Error("fxtwitter: file kosong");
    console.log("✅ Twitter via fxtwitter");
    return { file:dest, size:stat.size, ext, isImage:isImg };
}

// ── Generic ───────────────────────────────────────────────────────────────────
async function downloadGeneric(url) { return await downloadWithYtDlp(url); }

// ── Main exports ─────────────────────────────────────────────────────────────
export async function downloadVideo(url) {
    const cached = cacheGet(url);
    if (cached) return cached;

    let queueKey, fn;
    if      (/tiktok\.com/i.test(url))                     { queueKey="tiktok";    fn=()=>downloadTikTok(url);    }
    else if (/youtube\.com|youtu\.be/i.test(url))          { queueKey="youtube";   fn=()=>downloadYouTube(url);   }
    else if (/instagram\.com/i.test(url))                  { queueKey="instagram"; fn=()=>downloadInstagram(url); }
    else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) { queueKey="facebook";  fn=()=>downloadFacebook(url);  }
    else if (/twitter\.com|x\.com/i.test(url))             { queueKey="twitter";   fn=()=>downloadTwitter(url);   }
    else                                                    { queueKey="generic";   fn=()=>downloadGeneric(url);   }

    const result = await queues[queueKey].add(fn);
    cacheSet(url, result);
    return result;
}

export async function downloadAudio(url) {
    const isYT      = /youtube\.com|youtu\.be/i.test(url);
    const normalUrl = isYT ? normalizeYTUrl(url) : url;

    if (isYT) {
        try {
            const info = await playdl.video_info(normalUrl);
            const audioFmt = info?.format?.filter(f => f.url && (f.mimeType?.includes("audio") || f.hasAudio)).sort((a,b) => (parseInt(b.audioBitrate)||0)-(parseInt(a.audioBitrate)||0))[0] || info?.format?.filter(f => f.url)[0];
            if (audioFmt?.url) {
                const rawDest = tmpFile("mp4");
                await downloadFromUrl(audioFmt.url, rawDest);
                const mp3Dest = rawDest.replace(/\.\w+$/, ".mp3");
                await execFileAsync("ffmpeg", ["-y","-i",rawDest,"-vn","-ar","44100","-ac","2","-b:a","192k",mp3Dest], { timeout:120_000 });
                cleanFile(rawDest);
                const stat = fs.statSync(mp3Dest);
                if (stat.size > 0) return { file:mp3Dest, size:stat.size };
            }
        } catch (_) {}
    }

    const prefix  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outTmpl = path.join(TMP, `${prefix}.%(ext)s`);
    await execFileAsync(getYtDlpBin(), [
        "--no-playlist", "--socket-timeout","30","--retries","3",
        "-x","--audio-format","mp3","--audio-quality","0",
        "-o", outTmpl, ...getCookiesArgs(), normalUrl,
    ], { timeout:300_000, maxBuffer:20*1024*1024 }).catch(err => { throw new Error((err.stderr||err.message||"").slice(0,400)); });

    const files = fs.readdirSync(TMP).filter(f => f.startsWith(prefix));
    if (!files.length) throw new Error("yt-dlp audio: tidak ada output");
    const file = path.join(TMP, files[0]);
    const stat = fs.statSync(file);
    if (stat.size === 0) throw new Error("yt-dlp audio: file kosong");
    return { file, size:stat.size };
}

export async function extractThumbnail(videoFile) {
    const thumbFile = videoFile.replace(/\.\w+$/, "_thumb.jpg");
    try {
        await execFileAsync("ffmpeg", ["-y","-i",videoFile,"-ss","00:00:01","-vframes","1","-q:v","2","-vf","scale=320:-2",thumbFile], { timeout:15_000 });
        if (fs.existsSync(thumbFile) && fs.statSync(thumbFile).size > 500) return thumbFile;
    } catch (_) {}
    return null;
}

export async function getVideoTitle(url) {
    const isYT = /youtube\.com|youtu\.be/i.test(url);
    if (isYT) {
        try {
            const info = await playdl.video_info(normalizeYTUrl(url));
            if (info?.video_details?.title) return info.video_details.title.slice(0,60);
        } catch (_) {}
    }
    try {
        const { stdout } = await execFileAsync(getYtDlpBin(), ["--no-playlist","--print","title","--skip-download",...getCookiesArgs(),url], { timeout:20_000, maxBuffer:1024*1024 });
        return (stdout||"").trim().slice(0,60) || "Video";
    } catch (_) { return "Video"; }
}

// Cleanup file lama tiap 30 menit
setInterval(() => {
    try {
        const now = Date.now();
        fs.readdirSync(TMP).forEach(f => {
            const fp = path.join(TMP, f);
            try { if (now - fs.statSync(fp).mtimeMs > 30*60*1000) fs.unlinkSync(fp); } catch (_) {}
        });
    } catch (_) {}
}, 30*60*1000);
