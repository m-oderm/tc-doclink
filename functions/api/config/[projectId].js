// Konfiguration je Projekt mit persoenlicher Ueberschreibung.
//
//   GET    /api/config/:projectId                 -> { default, override, effective, isAdmin }
//   PUT    /api/config/:projectId?scope=user      -> speichert die persoenliche Ueberschreibung (Standard)
//   PUT    /api/config/:projectId?scope=project    -> speichert die Projekt-Vorgabe (nur Admin, sonst 403)
//   DELETE /api/config/:projectId?scope=user      -> loescht die persoenliche Ueberschreibung
//
// Speicher: Cloudflare KV (CONFIG_KV).
//   cfg:{projectId}                 -> Projekt-Vorgabe (gilt fuer alle)
//   cfg:{projectId}:user:{userId}    -> persoenliche Ueberschreibung
//
// Zugriff NUR fuer Projektmitglieder: Es wird ein Trimble-Bearer-Token verlangt und
// serverseitig gegen die Projektmitgliedschaft geprueft (Core-API GET /projects/{id}).
// Die userId wird serverseitig abgeleitet (Core-API GET /users/me, sonst JWT-sub) und
// niemals vom Client uebernommen. Die Admin-Rolle wird ueber die Projekt-Benutzerliste
// gelesen (Core-API GET /projects/{id}/users) und faellt im Zweifel auf "kein Admin".

const ALLOWED_FIELDS = ["pset", "attribute", "targetFolderId", "targetFolderName", "matchMode", "fileType", "skipArchive"];
const MATCH_MODES = ["exact", "contains"];
const FILE_TYPES = ["all", "pdf", "abs", "word", "excel"];
const KEY_OPS = ["and", "or"];
const MAX_BODY = 16 * 1024; // 16 KB
const MAX_RULES = 20;
const MAX_KEYS = 3; // hoechstens drei Schluessel-Attribute pro Regel
const MAX_FIELD = 512;

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const ctx = await gatherContext(env, request, id);
  if (ctx.error) return ctx.error;

  const def = await readRules(env, "cfg:" + id);
  const override = ctx.userId ? await readRules(env, userKey(id, ctx.userId)) : null;
  const effective = override || def;
  return new Response(JSON.stringify({ default: def, override, effective, isAdmin: ctx.isAdmin }), { headers: json() });
}

export async function onRequestPut(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const ctx = await gatherContext(env, request, id);
  if (ctx.error) return ctx.error;

  const scope = (new URL(request.url).searchParams.get("scope") || "user").toLowerCase();
  if (scope !== "user" && scope !== "project") return err("ungueltiger scope", 400);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return err("Konfiguration zu gross", 413);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return err("ungueltiges JSON", 400); }
  const norm = normalizeConfig(parsed, id);
  if (!norm.ok) return err(norm.message, norm.status);

  let key;
  if (scope === "project") {
    if (!ctx.isAdmin) return err("nur Projekt-Admins duerfen die Projekt-Vorgabe speichern", 403);
    key = "cfg:" + id;
  } else {
    if (!ctx.userId) return err("Benutzer nicht erkannt", 401);
    key = userKey(id, ctx.userId);
  }
  await env.CONFIG_KV.put(key, JSON.stringify(norm.value));

  // Antwort in derselben Form wie GET, damit das Frontend direkt uebernehmen kann.
  const def = scope === "project" ? norm.value : await readRules(env, "cfg:" + id);
  const override = scope === "user" ? norm.value : (ctx.userId ? await readRules(env, userKey(id, ctx.userId)) : null);
  const effective = override || def;
  return new Response(JSON.stringify({ default: def, override, effective, isAdmin: ctx.isAdmin, scope }), { headers: json() });
}

export async function onRequestDelete(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const ctx = await gatherContext(env, request, id);
  if (ctx.error) return ctx.error;

  const scope = (new URL(request.url).searchParams.get("scope") || "user").toLowerCase();
  if (scope !== "user") return err("nur scope=user kann geloescht werden", 400);
  if (!ctx.userId) return err("Benutzer nicht erkannt", 401);

  await env.CONFIG_KV.delete(userKey(id, ctx.userId));
  const def = await readRules(env, "cfg:" + id);
  return new Response(JSON.stringify({ default: def, override: null, effective: def, isAdmin: ctx.isAdmin }), { headers: json() });
}

// ---------- Zugriff + Identitaet + Rolle ----------

// Prueft Mitgliedschaft (wie bisher) und ermittelt userId und Admin-Status.
// Liefert { auth, base, userId, isAdmin } oder { error: Response }.
async function gatherContext(env, request, projectId) {
  const auth = request.headers.get("Authorization");
  if (!auth) return { error: err("Token fehlt", 401) };
  if (!projectId) return { error: err("projectId fehlt", 400) };
  const base = (env.CORE_API_BASE || "").replace(/\/+$/, "");
  if (!base) return { error: err("CORE_API_BASE nicht konfiguriert", 500) };

  // 1) Mitgliedschaft gegen die Core-API pruefen (gleiche Berechtigung wie die Dokumente).
  let m;
  try {
    m = await fetch(base + "/projects/" + encodeURIComponent(projectId),
      { headers: { Authorization: auth, Accept: "application/json" } });
  } catch (_) {
    return { error: err("Core-API nicht erreichbar", 502) };
  }
  if (m.status === 401 || m.status === 403) return { error: err("nicht berechtigt", 403) };
  if (!m.ok) return { error: err("Projektpruefung fehlgeschlagen (" + m.status + ")", 502) };

  // 2) Stabile Identitaet serverseitig ableiten (Core-API zuerst, JWT als Reserve).
  const identity = await resolveIdentity(base, auth);

  // 3) Admin-Rolle lesen. Bei jedem Fehler gilt: kein Admin (fail closed).
  const isAdmin = await isProjectAdmin(base, auth, projectId, identity);

  return { auth, base, userId: identity.id, isAdmin };
}

// Bevorzugt die Core-API (gleicher Id-Raum wie die Projekt-Benutzerliste), faellt auf
// das JWT zurueck. Liefert { id, email } - id kann null sein.
//
// Verifiziert an echten Quellen (offizielle Skill-Doku und produktiver Client-Code):
//   GET /users/me            -> { id, tiduuid, email, firstName, lastName, status }
//                               -> die stabile userId ist id (User-GUID).
//   GET /projects/{id}/users -> Array von { id, email, role, ... }
//                               -> Admin-Rolle ist role === "ADMIN".
async function resolveIdentity(base, auth) {
  try {
    const r = await fetch(base + "/users/me", { headers: { Authorization: auth, Accept: "application/json" } });
    if (r.ok) {
      const me = await r.json();
      const id = pickId(me);
      if (id) return { id, email: me && me.email ? String(me.email) : null };
    }
  } catch (_) { /* JWT-Reserve unten */ }
  const p = decodeJwt(auth) || {};
  const id = p.sub || p.user_id || p.userId || null;
  return { id: id != null ? String(id) : null, email: p.email ? String(p.email) : null };
}

function pickId(me) {
  if (!me || typeof me !== "object") return null;
  const v = me.id != null ? me.id : (me.userId != null ? me.userId : (me.uuid != null ? me.uuid : null));
  return v != null ? String(v) : null;
}

// Liest die Projekt-Benutzerliste und prueft, ob der Aufrufer Admin ist.
async function isProjectAdmin(base, auth, projectId, identity) {
  if (!identity || (!identity.id && !identity.email)) return false;
  let r;
  try {
    r = await fetch(base + "/projects/" + encodeURIComponent(projectId) + "/users",
      { headers: { Authorization: auth, Accept: "application/json" } });
  } catch (_) {
    return false;
  }
  if (!r.ok) return false;
  let data;
  try { data = await r.json(); } catch (_) { return false; }
  // Echte API liefert ein Array; manche Fassungen kapseln es (members/users/items/data).
  const list = Array.isArray(data) ? data : (data.members || data.users || data.items || data.data || []);
  return isAdminFromUsers(list, identity);
}

function isAdminFromUsers(list, identity) {
  const myId = identity && identity.id != null ? String(identity.id) : null;
  const myMail = identity && identity.email ? String(identity.email).toLowerCase() : null;
  for (const u of list || []) {
    if (!u || typeof u !== "object") continue;
    const uid = u.id != null ? String(u.id) : (u.userId != null ? String(u.userId) : "");
    const umail = u.email ? String(u.email).toLowerCase() : "";
    const mine = (myId && uid && uid === myId) || (myMail && umail && umail === myMail);
    if (mine && roleIsAdmin(u.role)) return true;
  }
  return false;
}

function roleIsAdmin(role) {
  const r = String(role == null ? "" : role).toUpperCase().replace(/[^A-Z]/g, "");
  return r === "ADMIN" || r === "PROJECTADMIN" || r === "OWNER" || r === "ACCOUNTADMIN";
}

// JWT-Payload ohne Signaturpruefung dekodieren (Token gilt durch die Mitgliedschaftspruefung
// bereits als gueltig). Nur fuer den Reserve-Pfad der Identitaet.
function decodeJwt(auth) {
  try {
    const tok = String(auth || "").replace(/^Bearer\s+/i, "");
    const part = tok.split(".")[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const txt = typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    return JSON.parse(decodeURIComponent(escape(txt)));
  } catch (_) {
    return null;
  }
}

// ---------- KV + Validierung ----------

function userKey(projectId, userId) { return "cfg:" + projectId + ":user:" + userId; }

async function readRules(env, key) {
  const val = await env.CONFIG_KV.get(key);
  if (!val) return null;
  try {
    const o = JSON.parse(val);
    return (o && Array.isArray(o.rules)) ? o : null;
  } catch (_) {
    return null;
  }
}

// Whitelist + Groessenbegrenzung + Normalisierung. Liefert { ok, value } oder { ok:false, status, message }.
function normalizeConfig(parsed, id) {
  if (!parsed || !Array.isArray(parsed.rules)) return { ok: false, status: 400, message: "rules[] erwartet" };
  if (parsed.rules.length > MAX_RULES) return { ok: false, status: 400, message: "zu viele Regeln" };
  const clean = { projectId: id, rules: [] };
  for (const r of parsed.rules) {
    if (!r || typeof r !== "object") return { ok: false, status: 400, message: "ungueltige Regel" };
    const out = {};
    for (const f of ALLOWED_FIELDS) {
      if (r[f] != null) out[f] = String(r[f]).slice(0, MAX_FIELD);
    }
    if (out.matchMode && !MATCH_MODES.includes(out.matchMode)) return { ok: false, status: 400, message: "ungueltiger matchMode" };
    if (out.fileType && !FILE_TYPES.includes(out.fileType)) return { ok: false, status: 400, message: "ungueltiger fileType" };
    if (out.skipArchive != null) out.skipArchive = (out.skipArchive === "1" || out.skipArchive === "true") ? "1" : "0";

    // Mehrere Schluessel-Attribute: keys[] mit pset, attribute, op (and/or).
    // Hoechstens MAX_KEYS, leere Eintraege fallen weg, op ausserhalb der Whitelist wird "and".
    if (Array.isArray(r.keys)) {
      const keys = [];
      for (const k of r.keys.slice(0, MAX_KEYS)) {
        if (!k || typeof k !== "object") continue;
        const key = {};
        if (k.pset != null) key.pset = String(k.pset).slice(0, MAX_FIELD);
        if (k.attribute != null) key.attribute = String(k.attribute).slice(0, MAX_FIELD);
        if (!key.attribute) continue; // ohne Attribut nutzlos
        key.op = KEY_OPS.includes(String(k.op || "").toLowerCase()) ? String(k.op).toLowerCase() : "and";
        keys.push(key);
      }
      if (keys.length) {
        out.keys = keys;
        // Erstes Attribut auch in die Einzelfelder spiegeln (Abwaertskompatibilitaet).
        out.pset = keys[0].pset != null ? keys[0].pset : "";
        out.attribute = keys[0].attribute;
      }
    }

    clean.rules.push(out);
  }
  return { ok: true, value: clean };
}

function json() { return { "Content-Type": "application/json" }; }
function err(msg, status) {
  return new Response(JSON.stringify({ error: msg }), { status: status || 400, headers: json() });
}

// Reine Helfer fuer Inline-Tests (kein Einfluss auf das Routing der Pages Function).
export const _internal = { normalizeConfig, isAdminFromUsers, roleIsAdmin, decodeJwt, pickId, MAX_KEYS };
