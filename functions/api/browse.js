// Ordner-Browser für die Konfig-UI.
//   GET /api/browse?projectId=...   -> löst die Projekt-Wurzel auf, listet deren Unterordner
//   GET /api/browse?folderId=...    -> listet die Unterordner EINER Ebene
// Antwort: { folderId, folders: [ { id, name } ] }
//
// ⚠️ Region-Host (CORE_API_BASE) muss euer Projekt treffen (CH/EU = app21).
// ⚠️ /projects/{id} (liefert rootId) und /folders/{id}/items gegen die Spec prüfen:
//    https://developer.trimble.com/docs/connect/core-api/

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let folderId = url.searchParams.get("folderId");
  const projectId = url.searchParams.get("projectId");
  const auth = request.headers.get("Authorization");

  if (!auth) return jsonResp({ error: "Token fehlt" }, 401);
  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return jsonResp({ error: "CORE_API_BASE nicht konfiguriert" }, 500);

  // Wurzel auflösen, wenn kein folderId übergeben wurde
  if (!folderId) {
    if (!projectId) return jsonResp({ error: "folderId oder projectId nötig" }, 400);
    let pr;
    try {
      pr = await fetch(base + "/projects/" + encodeURIComponent(projectId),
        { headers: { Authorization: auth, Accept: "application/json" } });
    } catch (e) {
      return jsonResp({ error: "Core-API nicht erreichbar", detail: String(e) }, 502);
    }
    if (!pr.ok) return jsonResp({ error: "Projekt nicht lesbar", status: pr.status, detail: await safeText(pr) }, pr.status);
    const proj = await pr.json();
    folderId = proj.rootId || (proj.data && proj.data.rootId);
    if (!folderId) return jsonResp({ error: "rootId im Projekt nicht gefunden" }, 502);
  }

  let r;
  try {
    r = await fetch(base + "/folders/" + encodeURIComponent(folderId) + "/items",
      { headers: { Authorization: auth, Accept: "application/json" } });
  } catch (e) {
    return jsonResp({ error: "Core-API nicht erreichbar", detail: String(e) }, 502);
  }
  if (!r.ok) return jsonResp({ error: "Ordner nicht lesbar", status: r.status, detail: await safeText(r) }, r.status);

  const data = await r.json();
  const items = Array.isArray(data) ? data : (data.items || data.data || []);
  const folders = items
    .filter((i) => String(i.type || "").toUpperCase().includes("FOLDER"))
    .map((i) => ({ id: i.id, name: i.name || i.title }));

  return jsonResp({ folderId, folders }, 200);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
async function safeText(r) { try { return await r.text(); } catch (_) { return ""; } }
