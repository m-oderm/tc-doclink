// Inline-Test der Konfig-Function mit gemocktem KV und gestubbtem fetch.
// Ausfuehren (gebuendeltes Node reicht, hat global fetch/Request/Response):
//   node test/config.test.mjs
//
// Die Function nutzt ESM-Exporte. Damit Node sie ohne package.json als ESM laedt,
// wird sie zur Laufzeit in eine temporaere .mjs-Datei kopiert und dynamisch importiert.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "functions", "api", "config", "[projectId].js"), "utf8");
const tmp = join(mkdtempSync(join(tmpdir(), "cfgtest-")), "config.mjs");
writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);

// ---------- kleine Test-Helfer ----------
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ok  - " + msg); }
  else { failed++; console.error("  FAIL- " + msg); }
}

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jwt(payload) { return "Bearer header." + b64url(payload) + ".sig"; }

function ctx({ projectId = "p1", token = "Bearer t", method = "GET", scope = null, body = null, kv } = {}) {
  let url = "https://x/api/config/" + projectId;
  if (scope) url += "?scope=" + scope;
  const init = { method, headers: { Authorization: token } };
  if (body != null) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  return { params: { projectId }, env: { CORE_API_BASE: "https://core", CONFIG_KV: kv }, request: new Request(url, init) };
}

const RULES_A = { projectId: "p1", rules: [{ pset: "PA", attribute: "AA", targetFolderId: "f1", matchMode: "exact" }] };
const RULES_B = { projectId: "p1", rules: [{ pset: "PB", attribute: "BB", targetFolderId: "f2", matchMode: "contains" }] };

async function run() {
  // fetch-Stub je Rolle: Mitgliedschaft, /users/me und Projekt-Benutzerliste.
  function fetchFor(role) {
    return async (url) => {
      const u = String(url);
      if (u.includes("/users/me")) return new Response(JSON.stringify({ id: "u1", email: "u1@x.ch" }), { status: 200 });
      if (u.includes("/users")) return new Response(JSON.stringify([{ id: "u1", email: "u1@x.ch", role }, { id: "u2", role: "ADMIN" }]), { status: 200 });
      if (u.includes("/projects/p1")) return new Response(JSON.stringify({ id: "p1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
  }

  // 1) Nicht-Admin kann scope=project NICHT speichern -> 403, KV unveraendert.
  {
    const kv = makeKV();
    globalThis.fetch = fetchFor("USER");
    const res = await mod.onRequestPut(ctx({ method: "PUT", scope: "project", body: RULES_B, kv }));
    ok(res.status === 403, "Nicht-Admin: scope=project -> 403");
    ok(!kv.store.has("cfg:p1"), "Nicht-Admin: Projekt-Vorgabe wurde nicht geschrieben");
  }

  // 2) Admin KANN scope=project speichern -> 200, schreibt cfg:p1.
  {
    const kv = makeKV();
    globalThis.fetch = fetchFor("ADMIN");
    const res = await mod.onRequestPut(ctx({ method: "PUT", scope: "project", body: RULES_B, kv }));
    ok(res.status === 200, "Admin: scope=project -> 200");
    ok(kv.store.has("cfg:p1"), "Admin: Projekt-Vorgabe geschrieben");
    ok(!kv.store.has("cfg:p1:user:u1"), "Admin: keine persoenliche Ueberschreibung angelegt");
  }

  // 3) scope=user schreibt nur die persoenliche Ueberschreibung.
  {
    const kv = makeKV({ "cfg:p1": JSON.stringify(RULES_A) });
    globalThis.fetch = fetchFor("USER");
    const res = await mod.onRequestPut(ctx({ method: "PUT", scope: "user", body: RULES_B, kv }));
    ok(res.status === 200, "User: scope=user -> 200");
    ok(kv.store.has("cfg:p1:user:u1"), "User: persoenliche Ueberschreibung geschrieben");
    ok(kv.store.get("cfg:p1") === JSON.stringify(RULES_A), "User: Projekt-Vorgabe blieb unveraendert");
  }

  // 4) GET: Override wird vor Default gelesen (effective = override).
  {
    const kv = makeKV({ "cfg:p1": JSON.stringify(RULES_A), "cfg:p1:user:u1": JSON.stringify(RULES_B) });
    globalThis.fetch = fetchFor("USER");
    const res = await mod.onRequestGet(ctx({ method: "GET", kv }));
    const j = await res.json();
    ok(j.default.rules[0].pset === "PA", "GET: default ist die Projekt-Vorgabe");
    ok(j.override.rules[0].pset === "PB", "GET: override ist die persoenliche Konfig");
    ok(j.effective.rules[0].pset === "PB", "GET: effective = override (vor default)");
    ok(j.isAdmin === false, "GET: isAdmin false fuer Nicht-Admin");
  }

  // 5) GET ohne Override: effective = default, isAdmin true fuer Admin.
  {
    const kv = makeKV({ "cfg:p1": JSON.stringify(RULES_A) });
    globalThis.fetch = fetchFor("ADMIN");
    const res = await mod.onRequestGet(ctx({ method: "GET", kv }));
    const j = await res.json();
    ok(j.override === null, "GET: kein Override -> override null");
    ok(j.effective.rules[0].pset === "PA", "GET: effective = default");
    ok(j.isAdmin === true, "GET: isAdmin true fuer Admin");
  }

  // 6) DELETE entfernt nur die eigene Ueberschreibung, Vorgabe bleibt.
  {
    const kv = makeKV({ "cfg:p1": JSON.stringify(RULES_A), "cfg:p1:user:u1": JSON.stringify(RULES_B) });
    globalThis.fetch = fetchFor("USER");
    const res = await mod.onRequestDelete(ctx({ method: "DELETE", scope: "user", kv }));
    ok(res.status === 200, "DELETE scope=user -> 200");
    ok(!kv.store.has("cfg:p1:user:u1"), "DELETE: persoenliche Ueberschreibung entfernt");
    ok(kv.store.has("cfg:p1"), "DELETE: Projekt-Vorgabe blieb erhalten");
    const j = await res.json();
    ok(j.effective.rules[0].pset === "PA", "DELETE: effective faellt zurueck auf default");
  }

  // 7) JWT-Reserve: faellt /users/me aus, wird sub als userId genutzt.
  {
    const kv = makeKV();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/users/me")) return new Response("{}", { status: 500 });
      if (u.includes("/users")) return new Response(JSON.stringify([]), { status: 200 });
      if (u.includes("/projects/p1")) return new Response(JSON.stringify({ id: "p1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const res = await mod.onRequestPut(ctx({ method: "PUT", scope: "user", token: jwt({ sub: "abc-123" }), body: RULES_B, kv }));
    ok(res.status === 200, "JWT-Reserve: scope=user -> 200");
    ok(kv.store.has("cfg:p1:user:abc-123"), "JWT-Reserve: Schluessel nutzt sub aus dem Token");
  }

  // 8) Normalisierung greift weiterhin: ungueltiger matchMode -> 400.
  {
    const kv = makeKV();
    globalThis.fetch = fetchFor("USER");
    const bad = { projectId: "p1", rules: [{ pset: "P", attribute: "A", matchMode: "boese" }] };
    const res = await mod.onRequestPut(ctx({ method: "PUT", scope: "user", body: bad, kv }));
    ok(res.status === 400, "Normalisierung: ungueltiger matchMode -> 400");
  }

  // 9) Nicht-Mitglied (Mitgliedschaftspruefung 403) -> 403, kein KV-Zugriff.
  {
    const kv = makeKV();
    globalThis.fetch = async () => new Response("{}", { status: 403 });
    const res = await mod.onRequestGet(ctx({ method: "GET", kv }));
    ok(res.status === 403, "Nicht-Mitglied: GET -> 403");
  }

  // 11) Admin-Erkennung auch bei gekapselter Liste { members: [...] } und Treffer per userId.
  {
    const kv = makeKV();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/users/me")) return new Response(JSON.stringify({ id: "u1", email: "u1@x.ch" }), { status: 200 });
      if (u.includes("/users")) return new Response(JSON.stringify({ members: [{ userId: "u1", role: "ADMIN" }] }), { status: 200 });
      if (u.includes("/projects/p1")) return new Response(JSON.stringify({ id: "p1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    const res = await mod.onRequestGet(ctx({ method: "GET", kv }));
    const j = await res.json();
    ok(j.isAdmin === true, "Admin: gekapselte Liste { members: [...] } und Treffer per userId");
  }

  // 12) Verifizierter users/me-Feldname: id wird als userId-Schluessel genutzt.
  {
    const kv = makeKV();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/users/me")) return new Response(JSON.stringify({ id: "guid-1", tiduuid: "tid-9", email: "a@x.ch" }), { status: 200 });
      if (u.includes("/users")) return new Response(JSON.stringify([]), { status: 200 });
      if (u.includes("/projects/p1")) return new Response(JSON.stringify({ id: "p1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
    await mod.onRequestPut(ctx({ method: "PUT", scope: "user", body: RULES_B, kv }));
    ok(kv.store.has("cfg:p1:user:guid-1"), "users/me: id (User-GUID) ist der Schluessel, nicht tiduuid");
  }

  // 10) Reine Helfer: roleIsAdmin und isAdminFromUsers.
  {
    const I = mod._internal;
    ok(I.roleIsAdmin("ADMIN") && I.roleIsAdmin("Project Admin") && !I.roleIsAdmin("USER"), "roleIsAdmin erkennt Admin-Rollen");
    ok(I.isAdminFromUsers([{ id: "u1", role: "ADMIN" }], { id: "u1" }) === true, "isAdminFromUsers: Treffer per id");
    ok(I.isAdminFromUsers([{ email: "A@x.ch", role: "ADMIN" }], { email: "a@x.ch" }) === true, "isAdminFromUsers: Treffer per email (case-insensitiv)");
    ok(I.isAdminFromUsers([{ id: "u9", role: "ADMIN" }], { id: "u1" }) === false, "isAdminFromUsers: fremder Admin zaehlt nicht");
  }

  // 13) keys-Normalisierung: Deckel auf 3, op-Whitelist, Spiegelung, Attribut-Pflicht.
  {
    const I = mod._internal;
    ok(I.MAX_KEYS === 3, "MAX_KEYS = 3");
    const res = I.normalizeConfig({ rules: [{
      targetFolderId: "f", matchMode: "contains", fileType: "all",
      keys: [
        { pset: "P1", attribute: "A1", op: "boese" },
        { pset: "P2", attribute: "A2", op: "or" },
        { attribute: "A3" },
        { pset: "P4", attribute: "A4" },
      ],
    }] }, "p1");
    ok(res.ok, "normalizeConfig mit keys: ok");
    const r0 = res.value.rules[0];
    ok(r0.keys.length === 3, "keys auf 3 begrenzt (viertes faellt weg)");
    ok(r0.keys[0].op === "and", "ungueltiger op wird and");
    ok(r0.keys[1].op === "or", "op or bleibt erhalten");
    ok(r0.pset === "P1" && r0.attribute === "A1", "erstes Attribut in pset/attribute gespiegelt");

    const res2 = I.normalizeConfig({ rules: [{ keys: [{ pset: "P" }, { attribute: "A2" }] }] }, "p1");
    const k2 = res2.value.rules[0].keys;
    ok(k2.length === 1 && k2[0].attribute === "A2", "key ohne attribute faellt weg");
  }

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}

run();
