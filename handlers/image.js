import sharp from "sharp";

export async function compressImage(buffer, mime = "image/jpeg", quality = 75) {
    const img  = sharp(buffer);
    const meta = await img.metadata();
    let out;
    if (mime === "image/png" || meta.format === "png") {
        out = await img.png({ quality, compressionLevel: 9 }).toBuffer();
    } else {
        out = await img.jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    return { buffer: out, originalSize: buffer.length, compressedSize: out.length };
}

function escapeXml(str) {
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
              .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

export async function makeSticker(buffer, text = "") {
    const SIZE = 512;
    let img = sharp(buffer).resize(SIZE, SIZE, { fit:"contain", background:{r:0,g:0,b:0,alpha:0} });

    if (text && text.trim()) {
        const t        = escapeXml(text.trim().toUpperCase());
        const fontSize = t.length > 12 ? 44 : t.length > 8 ? 52 : 62;
        const svg = Buffer.from(`
            <svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
                <text x="50%" y="92%" text-anchor="middle" dominant-baseline="auto"
                    font-family="Arial, sans-serif" font-weight="900" font-size="${fontSize}"
                    fill="white" stroke="black" stroke-width="6" paint-order="stroke fill"
                    letter-spacing="2">${t}</text>
            </svg>`);
        img = sharp(await img.png().toBuffer()).composite([{ input: svg, gravity: "south" }]);
    }

    return img.webp({ quality: 90 }).toBuffer();
}

export function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/(1024*1024)).toFixed(2)} MB`;
}
