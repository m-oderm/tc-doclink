// GET /api/files?folderId=...   (Authorization: Bearer <trimble-token>)
// Reicht den Token an die Trimble Core-API durch und listet den Ordnerinhalt.
// Antwort: [ { id, name, type ("FILE"|"FOLDER"), versionId, size } ]
//
// ⚠️ ZWEI STELLEN GEGEN EURE UMGEBUNG PRÜFEN:
//   1) CORE_API_BASE = Region-Host eures Projekts (CH/EU != NA-Master!).
//      In wrangler.toml bzw. im Pages-Dashboard als Variable setzen.
//   2) Der Items-Pfad (/folders/{id}/items) entspricht dem TC-API-2.0-Muster –
//      gegen die offizielle Core-API-Spec verifizieren:
//      https://developer.trimble.com/docs/connect/core-api/

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const auth = request.headers.get("Authorization");

  if (!folderId) return jsonResp({ error: "folderId fehlt" }, 400);
  if (!auth) return jsonResp({ error: "Token fehlt" }, 401);

  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return jsonResp({ error: "CORE_API_BASE nicht konfiguriert" }, 500);

  const tcUrl = base + "/folders/" + encodeURIComponent(folderId) + "/items";

  let r;
  try {
    r = await fetch(tcUrl, { headers: { Authorization: auth, Accept: "application/json" } });
  } catch (e) {
    return jsonResp({ error: "Core-API nicht erreichbar", detail: String(e) }, 502);
  }
  if (!r.ok) {
    return jsonResp({ error: "Core-API Fehler", status: r.status, detail: await safeText(r) }, r.status);
  }

  const data = await r.json();
  const items = Array.isArray(data) ? data : (data.items || data.data || []);
  const norm = items.map((i) => ({
    id: i.id,
    name: i.name || i.title,
    type: (i.type || "").toUpperCase().includes("FOLDER") ? "FOLDER" : "FILE",
    versionId: i.versionId || (i.version && i.version.id),
    size: i.size,
  }));
  return jsonResp(norm, 200);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
async function safeText(r) { try { return await r.text(); } catch (_) { return ""; } }
