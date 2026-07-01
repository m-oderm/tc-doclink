// Test des Ordner-Scans (files.js): Budget pro Aufruf, pending-Fortsetzung, skipArchive.
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

async function run() {
  // 1) Kleiner Baum innerhalb des Budgets -> alle Dateien, pending leer.
  {
    const tree = {
      R: { folders: [{ id: "A", name: "A" }, { id: "B", name: "B" }] },
      A: { files: [{ id: "a1", name: "a1.pdf" }, { id: "a2", name: "a2.pdf" }] },
      B: { folders: [{ id: "C", name: "C" }], files: [{ id: "b1", name: "b1.pdf" }] },
      C: { files: [{ id: "c1", name: "c1.pdf" }] },
    };
    globalThis.fetch = mockFetch(tree);
    const res = await mod.onRequest(ctx({ folderId: "R" }));
    const j = await res.json();
    ok(res.status === 200, "kleiner Baum: 200");
    ok(j.files.length === 4, "kleiner Baum: alle 4 Dateien (auch aus Unterordner C)");
    ok(j.pending.length === 0, "kleiner Baum: pending leer");
  }

  // 2) Budget-Grenze: 50 Unterordner -> GET liefert 44 Dateien und 6 pending, POST holt den Rest.
  {
    const tree = { R: { folders: [] } };
    for (let i = 1; i <= 50; i++) {
      tree.R.folders.push({ id: "f" + i, name: "f" + i });
      tree["f" + i] = { files: [{ id: "file" + i, name: "file" + i + ".pdf" }] };
    }
    globalThis.fetch = mockFetch(tree);
    const first = await (await mod.onRequest(ctx({ folderId: "R" }))).json();
    ok(first.files.length === 44, "Budget: erster Aufruf oeffnet 44 Ordner (1 Wurzel + 44 = 45 Calls)");
    ok(first.pending.length === 6, "Budget: 6 Ordner bleiben pending");

    const second = await (await mod.onRequest(ctx({ method: "POST", folders: first.pending }))).json();
    ok(second.files.length === 6, "Fortsetzung: POST holt die restlichen 6 Dateien");
    ok(second.pending.length === 0, "Fortsetzung: pending danach leer");

    const total = first.files.length + second.files.length;
    ok(total === 50, "Budget + Fortsetzung: zusammen alle 50 Dateien");
  }

  // 3) skipArchive laesst Archiv-/Alt-Ordner aus.
  {
    const tree = {
      R: { folders: [{ id: "Data", name: "Data" }, { id: "alt", name: "alt" }] },
      Data: { files: [{ id: "d1", name: "d1.pdf" }] },
      alt: { files: [{ id: "a1", name: "alt1.pdf" }] },
    };
    globalThis.fetch = mockFetch(tree);
    const j = await (await mod.onRequest(ctx({ folderId: "R", skipArchive: true }))).json();
    ok(j.files.length === 1 && j.files[0].id === "d1", "skipArchive: nur Data-Datei, alt uebersprungen");
  }

  // 4) Startordner unlesbar (GET) -> Fehlerstatus.
  {
    globalThis.fetch = mockFetch({}, { fail: new Set(["R"]), failStatus: 404 });
    const res = await mod.onRequest(ctx({ folderId: "R" }));
    ok(res.status === 502, "Startordner-Fehler (404) -> 502");
  }

  // 5) Startordner 403 -> 403.
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

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}
run();
