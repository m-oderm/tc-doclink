// GET /api/files?folderId=...   (Authorization: Bearer <trimble-token>)
// Durchsucht den angegebenen Ordner REKURSIV (inkl. Unterordner) und liefert
// eine flache Liste aller Dateien: [ { id, name, type:"FILE", versionId } ]
//
// ⚠️ Region-Host (CORE_API_BASE) gegen euer Projekt prüfen (CH/EU = app21).
// ⚠️ Items-Pfad /folders/{id}/items gegen die Core-API-Spec verifizieren:
//    https://developer.trimble.com/docs/connect/core-api/

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const auth = request.headers.get("Authorization");

  if (!folderId) return jsonResp({ error: "folderId fehlt" }, 400);
  if (!auth) return jsonResp({ error: "Token fehlt" }, 401);

  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return jsonResp({ error: "CORE_API_BASE nicht konfiguriert" }, 500);

  const MAX_DEPTH = 6;     // Schachtelungstiefe begrenzen
  const MAX_CALLS = 45;    // unter dem Cloudflare-Free-Limit (50 Subrequests/Request)
  let calls = 0;
  const files = [];

  async function listFolder(id, depth) {
    if (depth > MAX_DEPTH || calls >= MAX_CALLS) return;
    calls++;
    const r = await fetch(base + "/folders/" + encodeURIComponent(id) + "/items",
      { headers: { Authorization: auth, Accept: "application/json" } });
    if (!r.ok) {
      if (depth === 0) throw new Error("Core-API " + r.status + ": " + (await safeText(r)));
      return; // Fehler in Unterordnern ignorieren, oben weitersuchen
    }
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.items || data.data || []);
    const subfolders = [];
    for (const i of items) {
      const isFolder = String(i.type || "").toUpperCase().includes("FOLDER");
      if (isFolder) {
        subfolders.push(i.id);
      } else {
        files.push({
          id: i.id,
          name: i.name || i.title,
          type: "FILE",
          versionId: i.versionId || (i.version && i.version.id),
        });
      }
    }
    // Unterordner DERSELBEN Ebene parallel abfragen (schneller als sequenziell)
    const tasks = [];
    for (const sub of subfolders) {
      if (calls >= MAX_CALLS) break;
      tasks.push(listFolder(sub, depth + 1));
    }
    await Promise.all(tasks);
  }

  try {
    await listFolder(folderId, 0);
  } catch (e) {
    return jsonResp({ error: String(e.message || e) }, 502);
  }

  // flache Liste -> Frontend filtert/matcht unverändert weiter
  return jsonResp(files, 200);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
async function safeText(r) { try { return await r.text(); } catch (_) { return ""; } }
