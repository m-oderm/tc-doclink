// Test des Ordner-Scans (files.js): eine Ebene pro Aufruf, plus voller Client-Durchlauf.
// Ausfuehren: node test/files.test.mjs
//
// files.js nutzt ESM-Exporte. Damit Node sie ohne package.json laedt, wird die Datei
// zur Laufzeit in eine temporaere .mjs kopiert und dynamisch importiert.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "functions", "api", "files.js"), "utf8");
const tmp = join(mkdtempSync(join(tmpdir(), "filestest-")), "files.mjs");
writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => c ? (passed++, console.log("  ok  - " + m)) : (failed++, console.error("  FAIL- " + m));

// Baum: id -> { folders:[{id,name}], files:[{id,name}] }. fetch-Stub liefert die items.
function mockFetch(tree, opts = {}) {
  return async (u) => {
    const m = String(u).match(/\/folders\/([^/]+)\/items/);
    if (!m) return new Response("{}", { status: 404 });
    const id = decodeURIComponent(m[1]);
    if (opts.fail && opts.fail.has(id)) return new Response("nope", { status: opts.failStatus || 404 });
    const node = tree[id];
    if (!node) return new Response("[]", { status: 200 });
    const items = [
      ...(node.folders || []).map((f) => ({ id: f.id, name: f.name, type: "FOLDER" })),
      ...(node.files || []).map((f) => ({ id: f.id, name: f.name, type: "FILE", modifiedOn: "2026-06-01T00:00:00Z" })),
    ];
    return new Response(JSON.stringify(items), { status: 200 });
  };
}

function ctx({ method = "GET", folderId, folders, skipArchive } = {}) {
  let url = "https://x/api/files";
  const init = { method, headers: { Authorization: "Bearer t" } };
  if (method === "GET") {
    url += "?folderId=" + encodeURIComponent(folderId) + (skipArchive ? "&skipArchive=1" : "");
  } else {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ folders, skipArchive: !!skipArchive });
  }
  return { request: new Request(url, init), env: { CORE_API_BASE: "https://core" } };
}

// Simuliert den Frontend-Durchlauf: Warteschlange im Client, Server oeffnet eine Ebene.
async function fullScan(rootId, tree, skipArchive = false) {
  globalThis.fetch = mockFetch(tree);
  const byId = new Map();
  const seen = new Set();
  const queue = [];
  const enq = (ids) => { for (const id of ids || []) { const s = String(id); if (s && !seen.has(s)) { seen.add(s); queue.push(s); } } };
  enq([rootId]);
  let first = true, calls = 0, safety = 0;
  while (queue.length) {
    if (++safety > 400) break;
    const batch = queue.splice(0, 45);
    calls++;
    const c = first ? ctx({ folderId: batch[0], skipArchive }) : ctx({ method: "POST", folders: batch, skipArchive });
    first = false;
    const j = await (await mod.onRequest(c)).json();
    for (const f of j.files) if (!byId.has(f.id)) byId.set(f.id, f);
    enq(j.folders); enq(j.pending);
  }
  return { files: [...byId.values()], calls };
}

async function run() {
  // 1) Ein Aufruf oeffnet nur EINE Ebene: Dateien des Ordners + dessen Unterordner.
  {
    const tree = {
      R: { folders: [{ id: "A", name: "A" }], files: [{ id: "r1", name: "r1.pdf" }] },
      A: { files: [{ id: "a1", name: "a1.pdf" }] },
    };
    globalThis.fetch = mockFetch(tree);
    const j = await (await mod.onRequest(ctx({ folderId: "R" }))).json();
    ok(j.files.length === 1 && j.files[0].id === "r1", "eine Ebene: nur die Datei des Startordners");
    ok(j.folders.length === 1 && j.folders[0] === "A", "eine Ebene: Unterordner A wird gemeldet");
  }

  // 2) Voller Durchlauf, kleiner Baum: alle Dateien inkl. tiefer Ordner.
  {
    const tree = {
      R: { folders: [{ id: "A", name: "A" }, { id: "B", name: "B" }] },
      A: { files: [{ id: "a1", name: "a1.pdf" }, { id: "a2", name: "a2.pdf" }] },
      B: { folders: [{ id: "C", name: "C" }], files: [{ id: "b1", name: "b1.pdf" }] },
      C: { files: [{ id: "c1", name: "c1.pdf" }] },
    };
    const { files } = await fullScan("R", tree);
    ok(files.length === 4, "voller Durchlauf klein: alle 4 Dateien");
  }

  // 3) Grosser, tiefer Baum: 60 Geschosse x 3 Etappen x 1 Datei = 180 Dateien.
  //    Genau der Fall, der den frueheren Dedup-Bug ausgeloest hat (pending > Budget).
  {
    const tree = { R: { folders: [] } };
    let expected = 0;
    for (let g = 1; g <= 60; g++) {
      const gid = "g" + g;
      tree.R.folders.push({ id: gid, name: gid });
      tree[gid] = { folders: [] };
      for (let e = 1; e <= 3; e++) {
        const eid = "e" + g + "_" + e;
        tree[gid].folders.push({ id: eid, name: eid });
        tree[eid] = { files: [{ id: "file" + g + "_" + e, name: "L" + g + "_" + e + ".pdf" }] };
        expected++;
      }
    }
    const { files, calls } = await fullScan("R", tree);
    ok(files.length === 180, "grosser Baum: alle 180 Dateien gefunden (kein Verlust)");
    ok(expected === 180 && calls > 1, "grosser Baum: mehrere Aufruf-Runden noetig (" + calls + ")");
  }

  // 4) skipArchive laesst Archiv-/Alt-Ordner aus (im vollen Durchlauf).
  {
    const tree = {
      R: { folders: [{ id: "Data", name: "Data" }, { id: "alt", name: "alt" }] },
      Data: { files: [{ id: "d1", name: "d1.pdf" }] },
      alt: { files: [{ id: "a1", name: "alt1.pdf" }] },
    };
    const { files } = await fullScan("R", tree, true);
    ok(files.length === 1 && files[0].id === "d1", "skipArchive: alt-Ordner uebersprungen");
  }

  // 5) Startordner unlesbar (GET) -> Fehlerstatus.
  {
    globalThis.fetch = mockFetch({}, { fail: new Set(["R"]), failStatus: 404 });
    const res = await mod.onRequest(ctx({ folderId: "R" }));
    ok(res.status === 502, "Startordner-Fehler (404) -> 502");
  }
  {
    globalThis.fetch = mockFetch({}, { fail: new Set(["R"]), failStatus: 403 });
    const res = await mod.onRequest(ctx({ folderId: "R" }));
    ok(res.status === 403, "Startordner 403 -> 403");
  }

  // 6) POST mit fehlerhaftem Teilbaum -> ignoriert, 200.
  {
    const tree = { X: { files: [{ id: "x1", name: "x1.pdf" }] } };
    globalThis.fetch = mockFetch(tree, { fail: new Set(["Y"]), failStatus: 404 });
    const j = await (await mod.onRequest(ctx({ method: "POST", folders: ["X", "Y"] }))).json();
    ok(j.files.length === 1 && j.files[0].id === "x1", "POST: fehlerhafter Teilbaum Y ignoriert, X geliefert");
  }

  // 7) Mehr als 45 Ordner in einem POST -> Rest kommt als pending zurueck.
  {
    const tree = {};
    const many = [];
    for (let i = 1; i <= 50; i++) { const id = "p" + i; many.push(id); tree[id] = { files: [{ id: "f" + i, name: "f" + i + ".pdf" }] }; }
    globalThis.fetch = mockFetch(tree);
    const j = await (await mod.onRequest(ctx({ method: "POST", folders: many }))).json();
    ok(j.files.length === 45, "Budget: POST oeffnet hoechstens 45 Ordner");
    ok(j.pending.length === 5, "Budget: die restlichen 5 kommen als pending zurueck");
  }

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}
run();
