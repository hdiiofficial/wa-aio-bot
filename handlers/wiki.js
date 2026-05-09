export async function searchWiki(query) {
    const encoded = encodeURIComponent(query.trim());
    for (const lang of ["id", "en"]) {
        const res = await fetch(
            `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
            { headers: { "User-Agent": "AzisWABot/1.0" }, signal: AbortSignal.timeout(10_000) }
        );
        if (!res.ok) continue;
        const data = await res.json();
        if (data.type === "disambiguation") continue;
        const title   = data.title || query;
        const extract = data.extract || "";
        const url     = data.content_urls?.mobile?.page || data.content_urls?.desktop?.page || "";
        if (!extract) continue;
        const short = extract.length > 800
            ? extract.slice(0, 800).replace(/\s\S+$/, "") + "..."
            : extract;
        return { title, extract: short, url, lang };
    }
    throw new Error(`Tidak ditemukan di Wikipedia: "${query}"`);
}
