// Ordner-Scan fuer die Datei-Liste. Zwei Aufruf-Arten:
//
//   GET  /api/files?folderId=...&skipArchive=1        Startordner (Wurzel)
//   POST /api/files  { folders: [ids], skipArchive }  weitere Ordner (Fortsetzung)
//
// Antwort: { files: [ { id, name, type:"FILE", versionId, modified } ], pending: [folderId, ...] }
//   files   = alle in diesem Aufruf gefundenen Dateien (flach).
//   pending = Ordner, die wegen des Call-Budgets noch nicht geoeffnet wurden.
//
// Warum so: Cloudflare Free erlaubt nur ~50 Subrequests pro Function-Aufruf. Ein einziger
// Aufruf kann darum keinen grossen Ordnerbaum komplett scannen. Das Frontend ruft die
// Function darum mehrmals auf und reicht die pending-Ordner nach, bis pending leer ist.
// Jeder Aufruf hat sein eigenes Budget, so gibt es keine harte Obergrenze mehr.
//
// ⚠️ Region-Host (CORE_API_BASE) gegen euer Projekt pruefen (CH/EU = app21).

// Ordnernamen, die als Archiv gelten (ganzes Wort, damit z. B. "Altbau" NICHT zaehlt).
const ARCHIVE_RE = /(^|[ _\-])(alt|alte|archiv|archive|old|backup)([ _\-0-9]|$)/i;

const MAX_CALLS = 45;     // unter dem Cloudflare-Free-Limit (50 Subrequests/Request)
const MAX_ROOTS = 2000;   // Schutz gegen zu grosse pending-Listen pro Aufruf

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const auth = request.headers.get("Authorization");
  if (!auth) return jsonResp({ error: "Token fehlt" }, 401);

  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return jsonResp({ error: "CORE_API_BASE nicht konfiguriert" }, 500);

  // Startordner und Optionen aus GET (?folderId=) oder POST ({ folders: [...] }).
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
  if (roots.length > MAX_ROOTS) roots = roots.slice(0, MAX_ROOTS);

  let calls = 0;
  let rootError = null; // Status eines fehlgeschlagenen Startordners (nur GET)
  const files = [];
  const seenFolder = new Set();

  // Oeffnet einen Ordner: sammelt Dateien, liefert die Unterordner-Ids zurueck.
  async function expand(id, isRoot) {
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

  // Breitensuche in Wellen, bis das Call-Budget erschoepft ist.
  let frontier = roots.slice();
  let firstWave = rootErrorsFatal;
  while (frontier.length && calls < MAX_CALLS) {
    const room = MAX_CALLS - calls;
    const batch = frontier.slice(0, room);
    const rest = frontier.slice(room);
    calls += batch.length;
    const results = await Promise.all(batch.map((id, idx) => expand(id, firstWave && idx === 0)));
    firstWave = false;
    if (rootError != null) {
      const status = (rootError === 401 || rootError === 403) ? 403 : 502;
      return jsonResp({ error: "Ordner nicht lesbar (" + rootError + ")" }, status);
    }
    const next = [];
    for (const subs of results) {
      for (const s of subs) if (!seenFolder.has(s)) { seenFolder.add(s); next.push(s); }
    }
    frontier = rest.concat(next);
  }

  // frontier = noch nicht geoeffnete Ordner. Das Frontend reicht sie im naechsten Aufruf nach.
  return jsonResp({ files, pending: frontier }, 200);
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
