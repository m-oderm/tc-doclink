// Integrationstest der Konfig-UI-Logik fuer mehrere Regeln (ohne Browser).
// Ausfuehren: node test/config-ui.test.mjs
//
// app.js in einer vm-Sandbox mit Mock-DOM. Wir pruefen den Rundlauf:
// Konfig -> Formular-Entwuerfe -> Regel wechseln -> zurueck ins Server-Format.

import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(here, "..", "app.js"), "utf8");
src += "\n;globalThis.__c = { App, fillConfigForm, buildRulesFromForm, switchRule, addRule, removeActiveRule };";

let passed = 0, failed = 0;
const ok = (c, m) => c ? (passed++, console.log("  ok  - " + m)) : (failed++, console.error("  FAIL- " + m));

function makeEl() {
  const set = new Set();
  return {
    value: "", textContent: "", innerHTML: "",
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
      toggle: (c, f) => { if (f === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else { f ? set.add(c) : set.delete(c); } },
    },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
const elCache = new Map();
const document = {
  visibilityState: "visible", activeElement: null,
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, makeEl()); return elCache.get(id); },
  addEventListener() {}, removeEventListener() {},
};
const ctx = {
  document, console, JSON, Date, Math, Set, Map,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  location: { reload() {} }, window: { parent: {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const C = ctx.__c;

function run() {
  C.App.projectId = "p1";
  C.App.config = { projectId: "p1", rules: [
    { name: "Bewehrung", sourceContains: "BEW", nameContains: "BEW",
      keys: [{ pset: "Anliker", attribute: "Listennummer", op: "and", transform: { segments: [2, 3] } }],
      targetFolderId: "fEisen", targetFolderName: "Eisenlisten", matchMode: "contains", fileType: "pdf", skipArchive: "1" },
    { name: "Einbauteile", when: { attribute: "Bauteilname", value: "Rueckbiege", mode: "contains" }, nameContains: "EBT",
      keys: [{ pset: "Anliker", attribute: "Listennummer", op: "and", transform: { segments: [1, 2], ignoreSep: false } }],
      targetFolderId: "fStueck", targetFolderName: "Stuecklisten", matchMode: "contains", fileType: "pdf", skipArchive: "1" },
  ] };

  C.fillConfigForm();
  ok(C.App.rulesDraft.length === 2, "zwei Regel-Entwuerfe aus der Konfig");

  // Zwischen den Regeln wechseln (persistiert das Formular je Regel), dann bauen.
  C.switchRule(1);
  C.switchRule(0);
  const rules = C.buildRulesFromForm();
  ok(rules && rules.length === 2, "zwei Regeln ins Server-Format gebaut");

  ok(rules[0].name === "Bewehrung" && rules[0].nameContains === "BEW", "Regel 0: Name und Dateiname-Marker");
  ok(rules[0].sourceContains === "BEW", "Regel 0: sourceContains (IFC-Datei) erhalten");
  ok(rules[0].targetFolderId === "fEisen", "Regel 0: Zielordner");
  ok(rules[0].keys[0].transform && JSON.stringify(rules[0].keys[0].transform.segments) === "[2,3]", "Regel 0: Umformung erhalten");

  ok(rules[1].name === "Einbauteile" && rules[1].nameContains === "EBT", "Regel 1: Name und Marker");
  ok(rules[1].when && rules[1].when.mode === "contains", "Regel 1: when contains");
  ok(rules[1].targetFolderId === "fStueck", "Regel 1: Zielordner");
  ok(rules[1].keys[0].transform && rules[1].keys[0].transform.ignoreSep === false, "Regel 1: ignoreSep false erhalten");

  // Neue Regel hinzufuegen erhoeht die Zahl der Entwuerfe.
  C.addRule();
  ok(C.App.rulesDraft.length === 3, "addRule fuegt eine Regel hinzu");
  C.removeActiveRule();
  ok(C.App.rulesDraft.length === 2, "removeActiveRule entfernt sie wieder");

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}
run();
