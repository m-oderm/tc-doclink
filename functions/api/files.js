// Ordner-Scan fuer die Datei-Liste. Oeffnet die uebergebenen Ordner GENAU EINE Ebene
// tief und liefert deren Dateien plus deren Unterordner zurueck. Die Rekursion durch den
// Baum steuert das Frontend (es fuehrt die Warteschlange und ruft die Function mehrmals auf).
//
//   GET  /api/files?folderId=...&skipArchive=1        Startordner (Wurzel)
//   POST /api/files  { folders: [ids], skipArchive }  weitere Ordner (eine Ebene)
//
// Antwort: { files: [ { id, name, type:"FILE", versionId, modified } ],
//            folders: [ unterordnerId, ... ],   // neu entdeckte Unterordner
//            pending: [ ordnerId, ... ] }        // ueberzaehlige Eingaben (falls > Budget)
//
// Warum so: Cloudflare Free erlaubt nur ~50 Subrequests pro Function-Aufruf. Ein Aufruf
// oeffnet darum hoechstens MAX_CALLS Ordner. Weil das Frontend die Warteschlange fuehrt und
// jeden Ordner nur einmal sendet, gibt es keine harte Ordner-Grenze und nichts geht doppelt
// oder verloren.
//
// ⚠️ Region-Host (CORE_API_BASE) gegen euer Projekt pruefen (CH/EU = app21).

// Ordnernamen, die als Archiv gelten (ganzes Wort, damit z. B. "Altbau" NICHT zaehlt).
const ARCHIVE_RE = /(^|[ _\-])(alt|alte|archiv|archive|old|backup)([ _\-0-9]|$)/i;

const MAX_CALLS = 45;   // unter dem Cloudflare-Free-Limit (50 Subrequests/Request)

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const auth = request.headers.get("Authorization");
  if (!auth) return jsonResp({ error: "Token fehlt" }, 401);

  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return jsonResp({ error: "CORE_API_BASE nicht konfiguriert" }, 500);

  // Ordner und Optionen aus GET (?folderId=) oder POST ({ folders: [...] }).
  let roots = [];
  let skipArchive = url.searchParams.get("skipArchive") === "1";
  let rootErrorsFatal = false; // nur beim GET-Erstaufruf zaehlt ein Fehler am Startordner
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (_) { return jsonResp({ error: "ungueltiges JSON" }, 400); }
    roots = Array.isArray(body && body.folders) ? body.folders.filter(Boolean).map(String) : [];
    if (body && body.skipArchive) skipArchive = true;
  } else {
    const folderId = url.searchParams.get("folderId");
    if (folderId) { roots = [String(folderId)]; rootErrorsFatal = true; }
  }
  if (!roots.length) return jsonResp({ error: "folderId fehlt" }, 400);

  // Hoechstens MAX_CALLS Ordner pro Aufruf oeffnen; der Rest geht als pending zurueck.
  const batch = roots.slice(0, MAX_CALLS);
  const overflow = roots.slice(MAX_CALLS);

  const files = [];
  let rootError = null;

  // Oeffnet einen Ordner eine Ebene tief: sammelt Dateien, liefert die Unterordner-Ids.
  async function expandOne(id, isRoot) {
    let r;
    try {
      r = await fetch(base + "/folders/" + encodeURIComponent(id) + "/items",
        { headers: { Authorization: auth, Accept: "application/json" } });
    } catch (_) {
      if (isRoot) rootError = 502;
      return [];
    }
    if (!r.ok) { if (isRoot) rootError = r.status; return []; }
    let data;
    try { data = await r.json(); } catch (_) { return []; }
    const items = Array.isArray(data) ? data : (data.items || data.data || []);
    const subs = [];
    for (const i of items) {
      const isFolder = String(i.type || "").toUpperCase().includes("FOLDER");
      if (isFolder) {
        const fname = String(i.name || i.title || "");
        if (skipArchive && ARCHIVE_RE.test(fname)) continue; // Archiv-/Alt-Ordner auslassen
        if (i.id != null) subs.push(String(i.id));
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
    return subs;
  }

  const results = await Promise.all(batch.map((id, idx) => expandOne(id, rootErrorsFatal && idx === 0)));
  if (rootError != null) {
    const status = (rootError === 401 || rootError === 403) ? 403 : 502;
    return jsonResp({ error: "Ordner nicht lesbar (" + rootError + ")" }, status);
  }

  // Entdeckte Unterordner einsammeln (innerhalb dieses Aufrufs dedupliziert).
  const seen = new Set();
  const folders = [];
  for (const subs of results) {
    for (const s of subs) if (!seen.has(s)) { seen.add(s); folders.push(s); }
  }

  return jsonResp({ files, folders, pending: overflow }, 200);
}

// Aenderungsdatum defensiv aus moeglichen Feldern lesen (Feldname variiert je nach API-Version)
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
