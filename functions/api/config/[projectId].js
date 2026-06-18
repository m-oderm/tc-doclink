// GET  /api/config/:projectId  -> liest die Konfig (oder leeres Gerüst)
// PUT  /api/config/:projectId  -> speichert die Konfig
// Speicher: Cloudflare KV (CONFIG_KV).
//
// Zugriff NUR für Projektmitglieder: Es wird ein Trimble-Bearer-Token verlangt und
// serverseitig gegen die Projektmitgliedschaft geprüft (Core-API GET /projects/{id}).
// Damit hängt die Konfig an derselben Berechtigung wie die Dokumente.

const ALLOWED_FIELDS = ["pset", "attribute", "targetFolderId", "targetFolderName", "matchMode", "fileType", "skipArchive"];
const MATCH_MODES = ["exact", "contains"];
const FILE_TYPES = ["all", "pdf", "abs", "word", "excel"];
const MAX_BODY = 16 * 1024; // 16 KB
const MAX_RULES = 20;
const MAX_FIELD = 512;

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const gate = await assertMember(env, request, id);
  if (gate !== true) return gate; // Fehler-Response (401/403/500/502)

  const val = await env.CONFIG_KV.get("cfg:" + id);
  const body = val || JSON.stringify({ projectId: id, rules: [] });
  return new Response(body, { headers: json() });
}

export async function onRequestPut(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const gate = await assertMember(env, request, id);
  if (gate !== true) return gate;

  const raw = await request.text();
  if (raw.length > MAX_BODY) return err("Konfiguration zu gross", 413);

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return err("ungültiges JSON", 400); }
  if (!parsed || !Array.isArray(parsed.rules)) return err("rules[] erwartet", 400);
  if (parsed.rules.length > MAX_RULES) return err("zu viele Regeln", 400);

  // Nur erlaubte Felder als String übernehmen; matchMode/fileType gegen Whitelist.
  const clean = { projectId: id, rules: [] };
  for (const r of parsed.rules) {
    if (!r || typeof r !== "object") return err("ungültige Regel", 400);
    const out = {};
    for (const f of ALLOWED_FIELDS) {
      if (r[f] != null) out[f] = String(r[f]).slice(0, MAX_FIELD);
    }
    if (out.matchMode && !MATCH_MODES.includes(out.matchMode)) return err("ungültiger matchMode", 400);
    if (out.fileType && !FILE_TYPES.includes(out.fileType)) return err("ungültiger fileType", 400);
    if (out.skipArchive != null) out.skipArchive = (out.skipArchive === "1" || out.skipArchive === "true") ? "1" : "0";
    clean.rules.push(out);
  }

  await env.CONFIG_KV.put("cfg:" + id, JSON.stringify(clean));
  return new Response(JSON.stringify(clean), { headers: json() });
}

// true = berechtigtes Projektmitglied; sonst eine Fehler-Response.
async function assertMember(env, request, projectId) {
  const auth = request.headers.get("Authorization");
  if (!auth) return err("Token fehlt", 401);
  if (!projectId) return err("projectId fehlt", 400);
  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return err("CORE_API_BASE nicht konfiguriert", 500);

  let r;
  try {
    r = await fetch(base + "/projects/" + encodeURIComponent(projectId),
      { headers: { Authorization: auth, Accept: "application/json" } });
  } catch (_) {
    return err("Core-API nicht erreichbar", 502);
  }
  if (r.status === 401 || r.status === 403) return err("nicht berechtigt", 403);
  if (!r.ok) return err("Projektprüfung fehlgeschlagen (" + r.status + ")", 502);
  return true;
}

function json() { return { "Content-Type": "application/json" }; }
function err(msg, status) {
  return new Response(JSON.stringify({ error: msg }), { status: status || 400, headers: json() });
}
