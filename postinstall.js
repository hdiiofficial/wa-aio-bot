#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baileysDir = join(__dirname, "node_modules/@whiskeysockets/baileys/lib");

let patched = 0;

try {
    const vcPath = join(baileysDir, "Utils/validate-connection.js");
    let vc = readFileSync(vcPath, "utf8");
    const before = vc;
    vc = vc.replace(/passive:\s*true/g, "passive: false");
    vc = vc.replace(/lidDbMigrated:[^,\n}]+[,]?\n?/g, "");
    if (vc !== before) { writeFileSync(vcPath, vc); patched++; console.log("✅ Patched validate-connection.js"); }
    else console.log("ℹ️  validate-connection.js already patched");
} catch (e) { console.error("❌ Patch 1 failed:", e.message); }

try {
    const sockPath = join(baileysDir, "Socket/socket.js");
    let sock = readFileSync(sockPath, "utf8");
    const before = sock;
    sock = sock.replace(/await\s+noise\.finishInit\(\)/g, "noise.finishInit()");
    if (sock !== before) { writeFileSync(sockPath, sock); patched++; console.log("✅ Patched socket.js"); }
    else console.log("ℹ️  socket.js already patched");
} catch (e) { console.error("❌ Patch 2 failed:", e.message); }

console.log(`\n🔧 Baileys patches applied: ${patched}/2`);
