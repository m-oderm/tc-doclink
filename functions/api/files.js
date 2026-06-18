// GET /api/files?folderId=...&skipArchive=1   (Authorization: Bearer <trimble-token>)
// Durchsucht den angegebenen Ordner REKURSIV (inkl. Unterordner) und liefert eine
// flache Liste aller Dateien: [ { id, name, type:"FILE", versionId, modified } ].
// modified = Änderungsdatum (ISO), defensiv aus mehreren möglichen Feldern gelesen.
// skipArchive=1 überspringt Unterordner mit Namen wie "alt", "archiv", "old", "backup".
//
// ⚠️ Region-Host (CORE_API_BASE) gegen euer Projekt prüfen (CH/EU = app21).

// Ordnernamen, die als Archiv gelten (ganzes Wort, damit z. B. "Altbau" NICHT zählt).
const ARCHIVE_RE = /(^|[ _\-])(alt|alte|archiv|archive|old|backup)([ _\-0-9]|$)/i;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const skipArchive = url.searchParams.get("skipArchive") === "1";
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
        const fname = String(i.name || i.title || "");
        if (skipArchive && ARCHIVE_RE.test(fname)) continue; // Archiv-/Alt-Ordner auslassen
        subfolders.push(i.id);
      } else {
        files.push({
          id: i.id,
          name: i.name || i.title,
          type: "FILE",
          versionId: i.versionId || (i.version && i.version.id),
          modified: pickDate(i),
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

// Änderungsdatum defensiv aus möglichen Feldern lesen (Feldname variiert je nach API-Version)
function pickDate(i) {
  const v = i.version || {};
  return i.modifiedOn || i.versionModifiedOn || i.lastModified || i.updatedAt
    || v.modifiedOn || v.createdOn || i.modifiedAt || i.createdOn || null;
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
async function safeText(r) { try { return await r.text(); } catch (_) { return ""; } }
