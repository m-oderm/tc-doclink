// Test der Update-Logik in app.js mit gemocktem DOM und gestubbtem fetch.
// Ausfuehren: node test/version.test.mjs
//
// app.js ist kein Modul (laeuft eine IIFE beim Laden). Darum wird die Datei in einer
// vm-Sandbox mit Mock-Globals ausgefuehrt. Die connect()-IIFE bricht ohne Trimble
// kontrolliert ab. Danach werden loadVersion/checkForUpdate/showUpdateBar gezielt geprueft.

import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(here, "..", "app.js"), "utf8");
// Lexikalische Bindungen (const App, Funktionsdeklarationen) nach aussen reichen.
src += "\n;globalThis.__t = { App, loadVersion, checkForUpdate, showUpdateBar, startUpdateChecks, onVisibleCheck, bar: () => document.getElementById('update-bar') };";

let passed = 0, failed = 0;
const ok = (c, m) => c ? (passed++, console.log("  ok  - " + m)) : (failed++, console.error("  FAIL- " + m));

// ---- Mock-DOM ----
function makeEl(initial = []) {
  const set = new Set(initial);
  return {
    textContent: "",
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, f) => (f === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (f ? set.add(c) : set.delete(c))),
    },
    addEventListener() {}, removeEventListener() {},
  };
}
const els = new Map();
els.set("update-bar", makeEl(["hidden"]));
const document = {
  visibilityState: "visible",
  getElementById: (id) => (els.has(id) ? els.get(id) : (els.set(id, makeEl()), els.get(id))),
  addEventListener() {}, removeEventListener() {},
};

// ---- steuerbarer fetch-Stub ----
let nextVersion = null, nextOk = true;
const fetchStub = async () => ({ ok: nextOk, json: async () => ({ version: nextVersion, builtAt: "2026-06-20T10:00:00Z" }) });

let intervalHandle = 0, clearedHandles = [];
const ctx = {
  document, console, JSON, Date, Math,
  fetch: fetchStub,
  location: { reload() { ctx.__reloaded = true; } },
  setTimeout: (fn) => 0, clearTimeout: () => {},
  setInterval: () => (++intervalHandle), clearInterval: (h) => clearedHandles.push(h),
  window: { parent: {} },
  __reloaded: false,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const T = ctx.__t;

function resetBar() { els.get("update-bar").classList.add("hidden"); }
const barHidden = () => els.get("update-bar").classList.contains("hidden");

async function run() {
  // Basis: geladene Version setzen.
  nextOk = true; nextVersion = "aaaaaaa";
  await T.loadVersion();
  ok(T.App.loadedVersion === "aaaaaaa", "loadVersion merkt sich die geladene Version");
  ok(T.App.version && T.App.version.builtAt === "2026-06-20T10:00:00Z", "loadVersion merkt sich builtAt");

  // 1) Neue, verschiedene Version -> Leiste erscheint.
  resetBar();
  nextVersion = "bbbbbbb";
  await T.checkForUpdate();
  ok(!barHidden(), "Verschiedene echte Version: Leiste erscheint");

  // 2) Gleiche Version -> nichts.
  resetBar();
  nextVersion = "aaaaaaa";
  await T.checkForUpdate();
  ok(barHidden(), "Gleiche Version: keine Leiste");

  // 3) Aktuelle Version ist dev -> nichts.
  resetBar();
  nextVersion = "dev";
  await T.checkForUpdate();
  ok(barHidden(), "Aktuelle Version dev: keine Leiste");

  // 4) Geladene Version war dev -> nichts, auch bei echter neuer Version.
  resetBar();
  nextVersion = "dev"; await T.loadVersion();   // loadedVersion = dev
  nextVersion = "ccccccc"; await T.checkForUpdate();
  ok(barHidden(), "Geladene Version dev: keine Leiste");

  // 5) version.json nicht erreichbar -> nichts, kein Fehler.
  resetBar();
  nextVersion = "aaaaaaa"; await T.loadVersion(); // Basis wieder echt
  nextOk = false; nextVersion = "zzzzzzz";
  await T.checkForUpdate();
  nextOk = true;
  ok(barHidden(), "version.json nicht erreichbar: keine Leiste, kein Fehler");

  // 6) Sobald gezeigt, stoppt die Pruefung (clearInterval wird aufgerufen).
  clearedHandles = [];
  T.startUpdateChecks();
  nextVersion = "ddddddd";
  await T.checkForUpdate(); // App.loadedVersion ist aaaaaaa -> Leiste + Stopp
  ok(!barHidden(), "Stopp-Fall: Leiste erscheint");
  ok(clearedHandles.length === 1, "Sobald gezeigt: Intervall wird gestoppt (clearInterval)");

  // 7) onVisibleCheck prueft bei Sichtbarkeit erneut.
  resetBar();
  nextVersion = "aaaaaaa"; await T.loadVersion();
  let calls = 0; const real = ctx.fetch;
  ctx.fetch = async () => { calls++; return real(); };
  ctx.document.visibilityState = "visible";
  T.onVisibleCheck();
  await Promise.resolve();
  ok(calls >= 1, "onVisibleCheck loest bei Sichtbarkeit eine Pruefung aus");
  ctx.fetch = real;

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}
run();
