// Test der Matching-Engine in app.js (Mehrfach-Schluessel, und/oder).
// Ausfuehren: node test/matching.test.mjs
//
// app.js laeuft eine IIFE beim Laden. Die wird in einer vm-Sandbox mit Mock-Globals
// ausgefuehrt und bricht ohne Trimble kontrolliert ab. Danach werden die reinen
// Matching-Funktionen ueber ein angehaengtes globalThis.__m geprueft.

import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(here, "..", "app.js"), "utf8");
src += "\n;globalThis.__m = { ruleKeys, extractValues, combineMatch, valueInFile, matchFilesForKeys, tupleLabel, keyCandidates, applyTransform, splitSegments };";

let passed = 0, failed = 0;
const ok = (c, m) => c ? (passed++, console.log("  ok  - " + m)) : (failed++, console.error("  FAIL- " + m));

function makeEl() {
  const set = new Set();
  return { textContent: "", classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: () => {} }, addEventListener() {}, removeEventListener() {} };
}
const document = { visibilityState: "visible", getElementById: () => makeEl(), addEventListener() {}, removeEventListener() {} };
const ctx = {
  document, console, JSON, Date, Math, Set, Map,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  location: { reload() {} }, window: { parent: {} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const M = ctx.__m;

// kleine Hilfen
const files = (names) => names.map((n, i) => ({ id: "f" + i, name: n, type: "FILE" }));
const props = (pset, attr, value) => [{ properties: [{ name: pset, properties: [{ name: attr, value }] }] }];

function run() {
  // ruleKeys: abwaertskompatibel und Array-Form.
  ok(JSON.stringify(M.ruleKeys({ pset: "P", attribute: "A" })) === JSON.stringify([{ pset: "P", attribute: "A", op: "and" }]),
    "ruleKeys: alte Einzelangabe wird zu einem Eintrag");
  ok(M.ruleKeys({ keys: [{ attribute: "A" }, { attribute: "B", op: "or" }] }).length === 2,
    "ruleKeys: keys-Array wird durchgereicht");
  ok(M.ruleKeys({}).length === 0, "ruleKeys: ohne Attribut leer");

  // extractValues
  ok(M.extractValues(props("Pset", "Nr", "437.01"), [{ pset: "Pset", attribute: "Nr" }])[0] === "437.01",
    "extractValues liest den Wert");

  // tupleLabel
  ok(M.tupleLabel(["437.01", "", "Pos5"]) === "437.01 + Pos5", "tupleLabel verbindet vorhandene Werte");

  // combineMatch links nach rechts
  const test = (v) => v === "T";
  ok(M.combineMatch(["T", "F", "T"], [{}, { op: "or" }, { op: "and" }], test) === true, "combineMatch: (T oder F) und T = true");
  ok(M.combineMatch(["F", "F", "T"], [{}, { op: "or" }, { op: "and" }], test) === false, "combineMatch: (F oder F) und T = false");

  // valueInFile inkl. Float-Normalisierung
  ok(M.valueInFile({ name: "14.13.pdf" }, "14.129999999999999") === true, "valueInFile: Float-Rauschen wird normalisiert");
  ok(M.valueInFile({ name: "abc.pdf" }, "") === false, "valueInFile: leerer Wert passt nie");

  // EIN Attribut, exakt: nur exakter Basisname, sonst nichts
  {
    const fs = files(["437.01.pdf", "x_437.01_y.pdf"]);
    const keys = [{ pset: "P", attribute: "A", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["437.01"], keys, "exact", "all");
    ok(hits.length === 1 && hits[0].name === "437.01.pdf", "Ein Attribut exakt: nur exakter Dateiname");
  }
  // EIN Attribut, enthaelt: beide
  {
    const fs = files(["437.01.pdf", "x_437.01_y.pdf"]);
    const keys = [{ pset: "P", attribute: "A", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["437.01"], keys, "contains", "all");
    ok(hits.length === 2, "Ein Attribut enthaelt: beide Dateien");
  }
  // Dateityp-Filter
  {
    const fs = files(["437.01.pdf", "437.01.docx"]);
    const keys = [{ pset: "P", attribute: "A", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["437.01"], keys, "contains", "pdf");
    ok(hits.length === 1 && hits[0].name === "437.01.pdf", "Dateityp pdf filtert docx weg");
  }
  // ZWEI Attribute UND
  {
    const fs = files(["437_Pos5.pdf", "437_Pos9.pdf", "Pos5_only.pdf"]);
    const keys = [{ attribute: "A" }, { attribute: "B", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["437", "Pos5"], keys, "exact", "all");
    ok(hits.length === 1 && hits[0].name === "437_Pos5.pdf", "Zwei Attribute UND: nur Datei mit beiden Werten");
  }
  // ZWEI Attribute ODER
  {
    const fs = files(["437_Pos5.pdf", "437_Pos9.pdf", "Pos5_only.pdf", "anderes.pdf"]);
    const keys = [{ attribute: "A" }, { attribute: "B", op: "or" }];
    const hits = M.matchFilesForKeys(fs, ["437", "Pos5"], keys, "exact", "all");
    ok(hits.length === 3, "Zwei Attribute ODER: alle mit einem der Werte");
  }
  // UND mit fehlendem zweiten Wert -> kein Treffer
  {
    const fs = files(["437_Pos5.pdf"]);
    const keys = [{ attribute: "A" }, { attribute: "B", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["437", ""], keys, "exact", "all");
    ok(hits.length === 0, "UND mit fehlendem Wert: kein Treffer");
  }

  // ---------- Umformung (Segmente / Trennzeichen / Regex) ----------

  // splitSegments zerlegt an beliebigen Trennzeichen
  ok(JSON.stringify(M.splitSegments("0606/EB_BEWWA/4_K4_XX"))
    === JSON.stringify(["0606", "EB", "BEWWA", "4", "K4", "XX"]),
    "splitSegments: teilt an /, _ usw.");

  // applyTransform: Segment-Auswahl
  ok(M.applyTransform("099-1-02.11", { segments: [2, 3] }) === "02.11",
    "applyTransform: waehlt nur die gewuenschten Segmente");
  // applyTransform: Regex mit Gruppe
  ok(M.applyTransform("099-1-02.11", { regex: "(\\d+\\.\\d+)$" }) === "02.11",
    "applyTransform: Regex extrahiert die Gruppe");
  ok(M.applyTransform("099-1-02.11", null) === "099-1-02.11",
    "applyTransform: ohne Umformung unveraendert");

  // Fall 1: Listennummer 099-1-02.11, Datei traegt 099-U11-02.11.
  // Suffix 02.11 (Segmente) UND Etappe U11 -> genau eine Datei.
  {
    const fs = files([
      "2368.MA_ING_SYN_099-U11-02.11-BEW-DE-untere Lage_V01.pdf",
      "2368.MA_ING_SYN_099-U11-01.12-BEW-DE-obere Lage_V01.pdf",
      "2368.MA_ING_SYN_099-U11-02.12-BEW-DE-obere Lage_V01.pdf",
    ]);
    const keys = [{ attribute: "Listennummer", transform: { segments: [2, 3] } },
      { attribute: "Etappe", op: "and" }];
    const hits = M.matchFilesForKeys(fs, ["099-1-02.11", "U11"], keys, "exact", "all");
    ok(hits.length === 1 && hits[0].name.includes("02.11"),
      "Segment-Suffix + Etappe trifft genau die richtige Liste");
  }

  // Ohne Umformung wuerde die Listennummer hier nichts finden (Beleg fuers Problem).
  {
    const fs = files(["2368.MA_ING_SYN_099-U11-02.11-BEW-DE-untere Lage_V01.pdf"]);
    const keys = [{ attribute: "Listennummer" }];
    const hits = M.matchFilesForKeys(fs, ["099-1-02.11"], keys, "contains", "all");
    ok(hits.length === 0, "Ohne Umformung: 099-1-02.11 steht nicht im Dateinamen");
  }

  // Fall 2: Wert 0606/EB_BEWWA/4_K4_XX, Datei hat 0606_BEWWA_4_K4_XX (EB fehlt).
  // Stoer-Segment EB abwaehlen, Trennzeichen werden bei Segment-Auswahl ignoriert.
  {
    const fs = files([
      "USZ_MIT1_52_TRW_BM_0606_BEWWA_4_K4_XX_Bewehrungliste Kernwaende Ebene B_001.pdf",
      "USZ_MIT1_52_TRW_BM_0606_BEWWA_4_K4_YY_irgendwas_001.pdf",
    ]);
    const keys = [{ attribute: "RC_11", transform: { segments: [0, 2, 3, 4, 5] } }];
    const hits = M.matchFilesForKeys(fs, ["0606/EB_BEWWA/4_K4_XX"], keys, "contains", "all");
    ok(hits.length === 1 && hits[0].name.includes("K4_XX"),
      "Segment-Auswahl ohne EB trifft trotz / vs _ die richtige Datei");
  }

  // Trennzeichen ignorieren am ganzen Wert (ohne Segment-Auswahl)
  {
    const fs = files(["a_0606_BEWWA_b.pdf"]);
    const keys = [{ attribute: "X", transform: { ignoreSep: true } }];
    const hits = M.matchFilesForKeys(fs, ["0606/BEWWA"], keys, "contains", "all");
    ok(hits.length === 1, "Trennzeichen ignorieren: 0606/BEWWA passt auf 0606_BEWWA");
  }

  // 1:1-Projekt bleibt unveraendert (keine Umformung gesetzt).
  {
    const fs = files(["D_EG00_C_01.01_Eisenliste.pdf", "D_EG00_B_01.02_Eisenliste.pdf"]);
    const keys = [{ attribute: "Listennummer" }];
    const hits = M.matchFilesForKeys(fs, ["D_EG00_C_01.01"], keys, "contains", "all");
    ok(hits.length === 1 && hits[0].name.includes("C_01.01"),
      "1:1-Projekt: ganzer Wert trifft weiterhin direkt");
  }

  console.log("\n" + passed + " ok, " + failed + " fehlgeschlagen");
  if (failed) process.exit(1);
}
run();
