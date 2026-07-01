"use strict";

const App = {
  api: null,
  token: null,
  projectId: null,
  config: null,        // wirksame Konfig (effective): { projectId, rules: [ {pset, attribute, targetFolderId, matchMode} ] }
  hasOverride: false,  // true, wenn eine persoenliche Ueberschreibung gespeichert ist
  isAdmin: false,      // true, wenn der Benutzer Projekt-Admin ist (Projekt-Standard speicherbar)
  version: null,       // Inhalt von version.json: { version, builtAt }
  loadedVersion: null, // Versionsnummer beim Laden der Seite (Basis fuer den Update-Vergleich)
  view: "runtime",
  attrChoices: [],     // zwischengespeicherte Attribute (Bauteil oder ganzes Modell)
  attrLoading: false,  // verhindert parallele Ladevorgänge der Attribut-Auswahl
  keyRows: [],         // Schlüssel-Attribute der Konfig-Ansicht: [{ pset, attribute, op }]
  activeRow: 0,        // zuletzt fokussierte Attributzeile (für die Trefferliste)
  fileIndex: null,     // gecachte, flache Dateiliste des Zielordners
  fileIndexFolder: null,
  _indexPromise: null,
  selectedFolderId: null,
  selectedFolderName: "",
  modelLists: null,    // gecachtes Ergebnis des Modell-Scans: [{key, file}]
  fileObjects: null,   // fileId -> [{modelId, runtimeId}] für „Im Modell wählen"
  attrDecimals: null,  // aus der Mehrheit der Werte abgeleitete Nachkommastellen
};

const $ = (id) => document.getElementById(id);

// ---------- Start ----------
(async function init() {
  try {
    App.api = await TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
  } catch (e) {
    $("proj-sub").textContent = "Verbindung zu Trimble fehlgeschlagen.";
    return;
  }

  // Linkes Menü setzen
  try {
    App.api.ui.setMenu({
      title: "Doku-Verknüpfer",
      icon: location.origin + "/icon.svg",
      command: "doclink_main",
      subMenus: [],
    });
  } catch (_) {}

  // Projektkontext
  try {
    const proj = await App.api.project.getCurrentProject();
    App.projectId = proj && (proj.id || proj.projectId);
    $("proj-sub").textContent = proj ? (proj.name || App.projectId) : "kein Projekt";
  } catch (_) {
    $("proj-sub").textContent = "Projekt nicht lesbar";
  }

  await ensureToken();
  await loadConfig();
  await loadVersion();
  bindUI();
  showRuntime();
  startUpdateChecks();

  // Datei-Index im Hintergrund vorladen -> erster Abruf ist schnell
  if (App.config && App.config.rules[0]) {
    ensureFileIndex(App.config.rules[0].targetFolderId).catch(() => {});
  }
})();

// ---------- Versionsanzeige und Update-Hinweis ----------
// Laedt version.json einmal beim Start. Fehler werden still ignoriert.
async function loadVersion() {
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return;
    App.version = await r.json();
    App.loadedVersion = App.version && App.version.version;
  } catch (_) {}
}

// Prueft, ob eine neue Version deployt wurde. Zeigt nur bei echten, verschiedenen
// Werten einen Hinweis (nie bei "dev").
async function checkForUpdate() {
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const cur = j && j.version;
    if (!cur || cur === "dev") return;
    if (!App.loadedVersion || App.loadedVersion === "dev") return;
    if (cur !== App.loadedVersion) showUpdateBar();
  } catch (_) {}
}

let updTimer = null;
function startUpdateChecks() {
  if (updTimer) return;
  updTimer = setInterval(checkForUpdate, 5 * 60 * 1000); // alle 5 Minuten
  document.addEventListener("visibilitychange", onVisibleCheck);
}
function stopUpdateChecks() {
  if (updTimer) { clearInterval(updTimer); updTimer = null; }
  document.removeEventListener("visibilitychange", onVisibleCheck);
}
function onVisibleCheck() {
  if (document.visibilityState === "visible") checkForUpdate();
}

// Hinweis-Leiste zeigen und die Pruefung stoppen (die neue Version ist bereits bekannt).
function showUpdateBar() {
  const bar = $("update-bar");
  if (!bar || !bar.classList.contains("hidden")) return;
  bar.classList.remove("hidden");
  stopUpdateChecks();
}

// ---------- Events von Trimble ----------
let selRefreshTimer = null;
function onEvent(event, data) {
  if (event === "extension.command") {
    const cmd = data && data.data;
    if (cmd === "open_config") showConfig();
    else if (cmd === "doclink_main") showRuntime();
  } else if (event === "extension.accessToken") {
    const t = data && data.data;
    if (t && t !== "pending" && t !== "denied") App.token = t;
  } else if (/selection/i.test(event)) {
    // Auswahlwechsel: gewählt -> filtern, nichts gewählt -> alle Listen.
    // Exakter Event-Name variiert je nach Viewer-Version -> lose gematcht + entprellt.
    clearTimeout(selRefreshTimer);
    selRefreshTimer = setTimeout(() => {
      if (App.view === "runtime" && App.config) refreshRuntime();
      else if (App.view === "config") {
        // Bauteil gewählt -> dessen Attribute; nichts gewählt -> ganzes Modell.
        // (loadAttributeChoices rendert die Liste nur neu, wenn sie offen ist.)
        loadAttributeChoices(true);
      }
    }, 120);
  }
}

async function requestToken() {
  try {
    const res = await App.api.extension.requestPermission("accesstoken");
    if (res && res !== "pending" && res !== "denied") App.token = res;
  } catch (_) { /* Token kommt sonst per Event */ }
}

// Stellt sicher, dass ein Token vorliegt, bevor geschützte Endpunkte (Konfig) genutzt
// werden. Trimble liefert oft "pending" und sendet den Token erst per Event nach.
async function ensureToken(timeoutMs) {
  if (App.token) return App.token;
  await requestToken();
  if (App.token) return App.token;
  const limit = timeoutMs || 8000;
  const start = Date.now();
  while (!App.token && Date.now() - start < limit) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return App.token || null;
}

// ---------- Konfiguration laden/speichern ----------
async function loadConfig() {
  if (!App.projectId) return;
  try {
    const r = await fetch("/api/config/" + encodeURIComponent(App.projectId), {
      headers: { Authorization: "Bearer " + (App.token || "") },
    });
    if (r.ok) applyConfigResponse(await r.json());
  } catch (_) {}
}

// Antwort von GET/PUT/DELETE uebernehmen: wirksame Konfig, Override-Status, Admin-Status.
function applyConfigResponse(j) {
  const eff = j && j.effective;
  App.config = (eff && eff.rules && eff.rules.length) ? eff : null;
  App.hasOverride = !!(j && j.override);
  App.isAdmin = !!(j && j.isAdmin);
}

// scope = "user" (persoenlich) oder "project" (Projekt-Standard, nur Admin).
async function saveConfig(rule, scope) {
  const payload = { projectId: App.projectId, rules: [rule] };
  const qs = scope === "project" ? "?scope=project" : "?scope=user";
  const r = await fetch("/api/config/" + encodeURIComponent(App.projectId) + qs, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (App.token || "") },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Speichern fehlgeschlagen (" + r.status + ")");
  applyConfigResponse(await r.json());
}

// Persoenliche Ueberschreibung loeschen und zur Projekt-Vorgabe zurueckkehren.
async function deleteOverride() {
  const r = await fetch("/api/config/" + encodeURIComponent(App.projectId) + "?scope=user", {
    method: "DELETE",
    headers: { Authorization: "Bearer " + (App.token || "") },
  });
  if (!r.ok) throw new Error("Zuruecksetzen fehlgeschlagen (" + r.status + ")");
  applyConfigResponse(await r.json());
}

// ---------- Laufzeit ----------
// Entscheidet: Auswahl vorhanden -> filtern; nichts gewählt -> Modell-Listen.
async function refreshRuntime(force) {
  if (!App.config) { $("runtime-out").innerHTML = card(notConfigured()); return; }
  let sel = null;
  try { sel = await App.api.viewer.getSelection(); } catch (_) {}
  if (sel && sel.length && sel[0].objectRuntimeIds && sel[0].objectRuntimeIds.length) {
    lookupSelected(sel);
  } else {
    showModelLists(force === true);
  }
}

// Übersicht: nur die Listen, deren Schlüssel im GELADENEN MODELL vorkommen
// (wie die Datentabelle: Attributwerte im Modell sammeln, dann abgleichen).
const SCAN_CHUNK = 500;
async function showModelLists(force) {
  const out = $("runtime-out");
  if (!App.config) { out.innerHTML = card(notConfigured()); return; }
  if (!force && App.modelLists) { renderModelLists(App.modelLists); return; }

  const rule = App.config.rules[0];
  const keys = ruleKeys(rule);
  out.innerHTML = card('<span class="spinner"></span> &nbsp;Scanne Modell…');
  try {
    const files = await ensureFileIndex(rule.targetFolderId);
    const modelObjs = await App.api.viewer.getObjects();
    let total = 0;
    for (const mo of (modelObjs || [])) total += (mo.objects || []).length;

    // Bauteile nach ihrer Wertkombination buendeln. Gleiche Kombination = gleiche
    // Dateien, darum nur einmal abgleichen (haelt die Last gering, auch bei 3 Attributen).
    const tuples = new Map(); // tupleKey -> { vals, objs: [{ modelId, runtimeId }] }
    const noteObj = (vals, modelId, runtimeId) => {
      if (!vals.some(Boolean)) return; // kein einziger Wert -> nichts zu suchen
      const tupleKey = vals.join("\u0000");
      if (!tuples.has(tupleKey)) tuples.set(tupleKey, { vals, objs: [] });
      if (runtimeId != null) tuples.get(tupleKey).objs.push({ modelId, runtimeId });
    };
    let scanned = 0;
    for (const mo of (modelObjs || [])) {
      const objs = mo.objects || [];
      const need = [];
      for (const o of objs) {
        if (o && o.properties) {                 // Properties evtl. schon dabei
          noteObj(extractValues([o], keys), mo.modelId, o.id);
          scanned++;
        } else if (o) {
          need.push(o.id);
        }
      }
      for (let i = 0; i < need.length; i += SCAN_CHUNK) {
        const chunk = need.slice(i, i + SCAN_CHUNK);
        const props = await App.api.viewer.getObjectProperties(mo.modelId, chunk);
        for (const p of (props || [])) {
          noteObj(extractValues([p], keys), mo.modelId, p.id);
        }
        scanned += chunk.length;
        out.innerHTML = card('<span class="spinner"></span> &nbsp;Scanne Modell… ' + scanned + " / " + total);
      }
    }

    // Genauigkeit aus der Mehrheit der Werte des ersten Attributs ableiten
    // (Ausreisser/Float-Rauschen normalisieren).
    App.attrDecimals = modalDecimals([...tuples.values()].map((t) => t.vals[0]).filter(Boolean));

    // im Modell vorkommende Kombinationen -> passende Dateien (nach Datei dedupliziert)
    const seen = new Set();
    const result = [];
    const fileObjects = new Map(); // fileId -> [{ modelId, runtimeId }]
    for (const t of tuples.values()) {
      const matches = matchFilesForKeys(files, t.vals, keys, rule.matchMode, rule.fileType);
      for (const file of matches) {
        if (!fileObjects.has(file.id)) fileObjects.set(file.id, []);
        const arr = fileObjects.get(file.id);
        for (const o of t.objs) arr.push(o);
        if (!seen.has(file.id)) { seen.add(file.id); result.push({ key: tupleLabel(t.vals), file }); }
      }
    }
    App.fileObjects = fileObjects;
    result.sort((a, b) => String(a.file.name).localeCompare(String(b.file.name)));
    App.modelLists = result;
    renderModelLists(result);
  } catch (e) {
    out.innerHTML = card('<div class="warn">Modell-Scan fehlgeschlagen: ' + esc(e.message || e) + "</div>");
  }
}

function renderModelLists(result) {
  const out = $("runtime-out");
  if (!result.length) {
    out.innerHTML = card('<div class="empty">Keine passenden Listen im geladenen Modell.<br>'
      + '<span class="hint">Stimmen Attribut und Ordner in den Einstellungen?</span></div>');
    return;
  }
  let html = '<div class="badge">' + result.length + " Listen im Modell</div>"
    + '<input type="search" id="list-search" placeholder="Liste suchen (Name oder Nummer)…" autocomplete="off" />'
    + '<p class="hint" style="margin:6px 0 10px">Name antippen öffnet die Liste · Button wählt die Bauteile im Modell.</p>'
    + '<div class="listrows" id="listrows">';
  for (const r of result) {
    const objs = (App.fileObjects && App.fileObjects.get(r.file.id)) || [];
    const date = fmtDate(r.file.modified);
    const hay = esc((r.file.name + " " + (r.key || "")).toLowerCase());
    html += '<div class="listrow" data-hay="' + hay + '">'
      + '<div class="listrow-main">'
      + '<a class="listrow-name" href="' + esc(open2DUrl(r.file.id)) + '" target="_blank" rel="noopener" title="Liste öffnen">'
      + esc(r.file.name) + "</a>"
      + (date ? '<span class="listrow-date">geändert ' + esc(date) + "</span>" : "")
      + "</div>"
      + '<button class="selbtn js-select" type="button" data-fileid="' + esc(r.file.id) + '"'
      + (objs.length ? "" : " disabled")
      + ' title="Zugehörige Bauteile im Modell anwählen">' + SEL_ICON
      + "<span>" + (objs.length || 0) + "</span></button>"
      + "</div>";
  }
  html += '</div><p class="hint hidden" id="list-empty" style="margin-top:10px">Keine Liste passt zur Suche.</p>';
  out.innerHTML = card(html);

  const search = $("list-search");
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      document.querySelectorAll("#listrows .listrow").forEach((el) => {
        const match = !q || (el.getAttribute("data-hay") || "").includes(q);
        el.classList.toggle("hidden", !match);
        if (match) shown++;
      });
      $("list-empty").classList.toggle("hidden", shown !== 0);
    });
  }
}

// ISO-Datum -> "TT.MM.JJJJ" (leer, wenn ungültig/fehlend)
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear();
}

// Genau eine Liste zum gewählten Bauteil
async function lookupSelected(sel) {
  const out = $("runtime-out");
  out.innerHTML = card('<span class="spinner"></span> &nbsp;Suche Liste…');
  try {
    if (!sel) sel = await App.api.viewer.getSelection();
    if (!sel || !sel.length || !sel[0].objectRuntimeIds || !sel[0].objectRuntimeIds.length) {
      return showModelLists();
    }
    const rule = App.config.rules[0];
    const keys = ruleKeys(rule);
    const props = await App.api.viewer.getObjectProperties(sel[0].modelId, [sel[0].objectRuntimeIds[0]]);
    const vals = extractValues(props, keys);

    if (!vals.some(Boolean)) {
      const names = keys.map((k) => k.pset + " › " + k.attribute).join(", ");
      out.innerHTML = card('<div class="warn">Kein Schlüssel im Attribut <b>'
        + esc(names) + "</b> an diesem Bauteil.</div>" + backLink());
      return;
    }
    const label = tupleLabel(vals);
    const hits = await findFilesForKeys(rule.targetFolderId, vals, keys, rule.matchMode, rule.fileType);
    if (!hits.length) {
      out.innerHTML = card('<div class="warn">Keine Liste zu Schlüssel '
        + '<span class="key">' + esc(displayKey(label)) + "</span> gefunden.</div>" + backLink());
      return;
    }
    showResults(label, hits);
  } catch (e) {
    out.innerHTML = card('<div class="warn">Fehler: ' + esc(e.message || String(e)) + "</div>");
  }
}

// Wählt im 3D-Modell alle Bauteile an, die zu dieser Liste gehören (gleiche Nummer),
// und zoomt darauf. Nutzt die gemerkten Bauteil-IDs aus dem Modell-Scan.
async function selectObjectsForFile(fileId) {
  const objs = (App.fileObjects && App.fileObjects.get(fileId)) || [];
  if (!objs.length) return;
  const byModel = new Map();
  for (const o of objs) {
    if (!byModel.has(o.modelId)) byModel.set(o.modelId, []);
    byModel.get(o.modelId).push(o.runtimeId);
  }
  const selector = {
    modelObjectIds: [...byModel.entries()].map(([modelId, ids]) => ({ modelId, objectRuntimeIds: ids })),
  };
  try {
    await App.api.viewer.setSelection(selector, "set");
    try { await App.api.viewer.setCamera(selector, { animationTime: 500 }); } catch (_) {}
  } catch (_) { /* Auswahl im Viewer nicht möglich -> still ignorieren */ }
}

function open2DUrl(fileId) {
  // 2D-Viewer-Link (PDF/Zeichnungen). Der data/files-Pfad öffnet nur ein leeres Fenster.
  const fid = encodeURIComponent(fileId);
  const pid = encodeURIComponent(App.projectId);
  return "https://web.connect.trimble.com/projects/" + pid
    + "/viewer/2D?id=" + fid + "&version=" + fid + "&type=revisions&etag=" + fid;
}

function backLink() {
  return '<button class="ghost js-all" type="button" style="width:100%;margin-top:12px">← Alle Listen</button>';
}

function notConfigured() {
  return '<div class="empty">Noch nicht konfiguriert.<br>'
    + '<span class="hint">Oben rechts auf ⚙ tippen, um die Verknüpfung einzurichten.</span></div>';
}

function showResults(key, files) {
  const sorted = files.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let html = '<div class="badge">Schlüssel <span class="key">' + esc(displayKey(key)) + "</span></div>";
  if (sorted.length === 1) {
    const f = sorted[0];
    html += '<div class="result-name" style="margin:8px 0">' + esc(f.name) + "</div>"
      + '<a href="' + esc(open2DUrl(f.id)) + '" target="_blank" rel="noopener">'
      + '<button class="primary">Dokument öffnen</button></a>';
  } else {
    html += '<p class="hint" style="margin:8px 0 10px">' + sorted.length + " Dateien zu diesem Schlüssel:</p>"
      + '<div class="filelist">';
    for (const f of sorted) {
      html += '<a class="filerow" href="' + esc(open2DUrl(f.id)) + '" target="_blank" rel="noopener">'
        + esc(f.name) + "</a>";
    }
    html += "</div>";
  }
  $("runtime-out").innerHTML = card(html + backLink());
}

// Defensiver Durchlauf durch die ObjectProperties-Struktur
function extractValue(propsArray, psetName, attrName) {
  for (const obj of propsArray || []) {
    const sets = obj.properties || obj.propertySets || [];
    for (const set of sets) {
      if (psetName && set.name !== psetName) continue;
      const list = set.properties || [];
      for (const p of list) {
        if (p.name === attrName && p.value != null && String(p.value).trim() !== "") {
          return String(p.value).trim();
        }
      }
    }
  }
  return "";
}

// Lädt die (rekursive) Dateiliste des Ordners EINMAL und cached sie.
async function ensureFileIndex(folderId, force) {
  if (force || App.fileIndexFolder !== folderId) {
    App.fileIndex = null;
    App.fileIndexFolder = folderId;
    App._indexPromise = null;
  }
  if (App.fileIndex) return App.fileIndex;
  if (!App._indexPromise) {
    const skip = (App.config && App.config.rules[0] && App.config.rules[0].skipArchive === "1") ? "&skipArchive=1" : "";
    App._indexPromise = (async () => {
      const r = await fetch("/api/files?folderId=" + encodeURIComponent(folderId) + skip, {
        headers: { Authorization: "Bearer " + (App.token || "") },
      });
      if (!r.ok) throw new Error("Ordner nicht lesbar (" + r.status + ")");
      const items = await r.json();
      App.fileIndex = (items || []).filter((i) => i.type !== "FOLDER");
      return App.fileIndex;
    })();
  }
  try { return await App._indexPromise; }
  finally { App._indexPromise = null; }
}

// Erzeugt Match-Kandidaten für einen Schlüssel und behebt dabei Float-Fehler
// (z. B. "14.129999999999999" -> "14.13", "9.998999999999999" -> "9.999")
// ohne echte Nachkommastellen zu verlieren, plus Variante mit führender Null
// für Dateinamen wie "09.999".
function keyCandidates(key) {
  const raw = String(key == null ? "" : key).trim();
  const set = new Set([raw]);
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (!isNaN(num)) {
      // toFixed(6) entfernt das Float-Rauschen (~13.+ Stelle), echte Stellen bleiben
      addNumVariants(set, String(parseFloat(num.toFixed(6)))); // "9.999" / "14.13"
      // Genauigkeit aus der Mehrheit der Modellwerte (sonst 3 als sinnvoller Default)
      const D = (App.attrDecimals != null) ? App.attrDecimals : 3;
      addNumVariants(set, num.toFixed(D));                     // feste D Stellen, z. B. "9.999"
      addNumVariants(set, String(parseFloat(num.toFixed(D)))); // ohne überflüssige Nullen
    }
  }
  return [...set].filter(Boolean);
}

// Ermittelt die häufigste Nachkommastellen-Anzahl unter den "sauberen" Werten
// (Float-Rauschen mit langer Ziffernkette wird ignoriert). So definiert die
// Mehrheit die erwartete Genauigkeit, auf die Ausreisser normalisiert werden.
function modalDecimals(values) {
  const counts = {};
  for (const v of values || []) {
    const m = String(v == null ? "" : v).trim().match(/^-?\d+\.(\d+)$/);
    if (m && m[1].length <= 6) counts[m[1].length] = (counts[m[1].length] || 0) + 1;
  }
  let best = null, bestN = -1;
  for (const d in counts) if (counts[d] > bestN) { bestN = counts[d]; best = Number(d); }
  return best; // null, wenn keine numerischen Werte vorliegen
}

// Fügt einen Zahl-String hinzu sowie – bei einstelligem Ganzzahlteil – die
// Variante mit führender Null (z. B. "9.999" -> auch "09.999").
function addNumVariants(set, v) {
  set.add(v);
  const m = v.match(/^(-?)(\d+)(\.\d+)?$/);
  if (m && m[2].length < 2) set.add(m[1] + m[2].padStart(2, "0") + (m[3] || ""));
}

const FILE_TYPE_EXT = {
  pdf: ["pdf"],
  abs: ["abs"],
  word: ["doc", "docx"],
  excel: ["xls", "xlsx", "xlsm", "xlsb", "csv"],
};
function fileAllowed(name, fileType) {
  if (!fileType || fileType === "all") return true;
  const exts = FILE_TYPE_EXT[fileType] || [];
  const ext = String(name || "").split(".").pop().toLowerCase();
  return exts.includes(ext);
}

const lc = (s) => String(s || "").toLowerCase();
const stripExt = (s) => String(s || "").replace(/\.[^.]+$/, "");

// Trennzeichen, die in Attributwerten und Dateinamen vorkommen koennen
// (Bindestrich, Punkt, Unterstrich, Schraegstrich, Backslash, Leerraum).
const SEP_RE = /[-._/\\\s]+/g;
const splitSegments = (v) => String(v == null ? "" : v).trim().split(SEP_RE).filter(Boolean);
const stripSep = (s) => String(s || "").replace(SEP_RE, "");

// Wendet die optionale Umformung eines Schluessels auf den Rohwert an und gibt
// den Suchbegriff zurueck. "" bedeutet: kein Treffer moeglich. Ohne Umformung
// bleibt der Rohwert unveraendert (= bisheriges Verhalten).
//  - transform.regex:    extrahiert die erste Gruppe (sonst den ganzen Treffer)
//  - transform.segments: behaelt nur die gewaehlten, an Trennzeichen geteilten Teile
function applyTransform(value, transform) {
  const raw = String(value == null ? "" : value).trim();
  if (!transform) return raw;
  if (transform.regex) {
    try {
      const m = raw.match(new RegExp(transform.regex, "i"));
      if (!m) return "";
      return m[1] != null ? m[1] : m[0];
    } catch (e) {
      return raw; // ungueltiges Muster -> wie ohne Umformung behandeln
    }
  }
  if (Array.isArray(transform.segments) && transform.segments.length) {
    const segs = splitSegments(raw);
    const picked = transform.segments.map((i) => segs[i]).filter((s) => s != null && s !== "");
    return picked.join("."); // Trenner egal, da beim Vergleich entfernt
  }
  return raw;
}

// Vergleicht dieser Schluessel separatoren-unempfindlich? Bei Segment-Auswahl und
// Regex automatisch, sonst nur wenn ausdruecklich gewuenscht.
function transformIgnoresSep(transform) {
  return !!(transform && (transform.ignoreSep
    || transform.regex
    || (Array.isArray(transform.segments) && transform.segments.length)));
}

// Suchkandidaten eines Schluessels. Ohne umformende Einstellung gilt die bisherige
// Float-Normalisierung; bei Segment-/Regex-Umformung der umgeformte Begriff selbst
// (eine ID, daher keine Zahl-Varianten).
function keyNeedles(value, transform) {
  const base = applyTransform(value, transform);
  if (!base) return [];
  const reshaped = transform && (transform.regex
    || (Array.isArray(transform.segments) && transform.segments.length));
  return reshaped ? [base] : keyCandidates(base);
}

// Enthaelt der Dateiname einen Kandidaten dieses Schluessels? (key optional)
function keyTest(fileName, value, key) {
  const t = key && key.transform;
  const ign = transformIgnoresSep(t);
  const cands = keyNeedles(value, t).map((c) => (ign ? stripSep(lc(c)) : lc(c))).filter(Boolean);
  if (!cands.length) return false;
  const name = ign ? stripSep(lc(fileName)) : lc(fileName);
  return cands.some((c) => name.includes(c));
}

// Entspricht der (endungslose) Dateiname exakt einem Kandidaten?
function keyTestExact(fileName, value, key) {
  const t = key && key.transform;
  const ign = transformIgnoresSep(t);
  const cands = keyNeedles(value, t).map((c) => (ign ? stripSep(lc(c)) : lc(c))).filter(Boolean);
  if (!cands.length) return false;
  const base = ign ? stripSep(lc(stripExt(fileName))) : lc(stripExt(fileName));
  return cands.some((c) => base === c);
}

// Schluessel-Attribute einer Regel als Array. Abwaertskompatibel zur frueheren
// Einzelangabe (pset/attribute).
function ruleKeys(rule) {
  if (rule && Array.isArray(rule.keys) && rule.keys.length) return rule.keys;
  if (rule && rule.attribute) return [{ pset: rule.pset, attribute: rule.attribute, op: "and" }];
  return [];
}

// Werte aller Schluessel-Attribute an einem Bauteil (gleiche Reihenfolge wie keys).
function extractValues(propsArray, keys) {
  return keys.map((k) => extractValue(propsArray, k.pset, k.attribute));
}

// Beschriftung aus den vorhandenen Werten, zum Beispiel "437.01 + Pos5".
function tupleLabel(vals) {
  return (vals || []).filter(Boolean).join(" + ");
}

// Verknuepft die Einzeltreffer mit und/oder, von links nach rechts ausgewertet.
// test erhaelt (wert, schluessel, index) -> zusaetzliche Argumente sind optional.
function combineMatch(vals, keys, test) {
  if (!vals.length) return false;
  let res = test(vals[0], keys[0], 0);
  for (let i = 1; i < vals.length; i++) {
    const m = test(vals[i], keys[i], i);
    res = (keys[i] && keys[i].op === "or") ? (res || m) : (res && m);
  }
  return res;
}

// Enthaelt der Dateiname einen der Kandidaten dieses Werts? (ohne Umformung)
function valueInFile(file, value) {
  if (!value) return false;
  return keyTest(file.name, value, null);
}

// Ein Attribut: bestehendes Verhalten (exakt bevorzugt, sonst enthaelt).
function matchPoolSingle(pool, value, key, matchMode) {
  if (matchMode === "contains") {
    return pool.filter((f) => keyTest(f.name, value, key));
  }
  const exact = pool.filter((f) => keyTestExact(f.name, value, key));
  if (exact.length) return exact;
  return pool.filter((f) => keyTest(f.name, value, key));
}

// Dateien, die zu den Werten passen. Ein Attribut wie bisher; mehrere Attribute
// werden ueber und/oder verknuepft, dabei gilt pro Wert "enthaelt".
function matchFilesForKeys(files, vals, keys, matchMode, fileType) {
  const pool = (files || []).filter((f) => fileAllowed(f.name, fileType));
  if (keys.length <= 1) return matchPoolSingle(pool, vals[0], keys[0], matchMode);
  return pool.filter((f) => combineMatch(vals, keys, (v, k) => keyTest(f.name, v, k)));
}

// Schlüssel für die Anzeige bereinigen — nur offensichtliches Float-Rauschen.
function displayKey(key) {
  const raw = String(key == null ? "" : key).trim();
  if (/^-?\d+\.\d*(9{4,}|0{4,})\d?$/.test(raw)) {
    const num = Number(raw);
    if (!isNaN(num)) return String(parseFloat(num.toFixed(6)));
  }
  return raw;
}

async function findFilesForKeys(folderId, vals, keys, matchMode, fileType) {
  let files = await ensureFileIndex(folderId);
  let hits = matchFilesForKeys(files, vals, keys, matchMode, fileType);
  if (!hits.length) {
    // evtl. neu hinzugekommene Datei -> Index einmal frisch laden und nochmal suchen
    files = await ensureFileIndex(folderId, true);
    hits = matchFilesForKeys(files, vals, keys, matchMode, fileType);
  }
  return hits;
}

// ---------- Konfig-Ansicht: durchsuchbare Attribut-Auswahl ----------
// Lädt die Attribute des gewählten Bauteils EINMAL und cached sie.
let attrLoadSeq = 0;
async function loadAttributeChoices(force) {
  if (App.attrChoices.length && !force) return;
  if (App.attrLoading && !force) return;
  const myId = ++attrLoadSeq; // neueste Anfrage gewinnt (stale-write-Schutz)
  App.attrLoading = true;
  const hint = $("attr-hint");
  try {
    const sel = await App.api.viewer.getSelection();
    const hasSel = sel && sel.length && sel[0].objectRuntimeIds && sel[0].objectRuntimeIds.length;
    if (hasSel) {
      hint.textContent = "lese Bauteil…";
      const choices = await attrsOfSelection(sel);
      if (myId !== attrLoadSeq) return;
      App.attrChoices = choices;
      hint.textContent = App.attrChoices.length + " Attribute des Bauteils — tippen zum Filtern.";
    } else {
      hint.textContent = "scanne Modell…";
      const choices = await attrsOfModel((done, total) => {
        if (myId === attrLoadSeq) hint.textContent = "scanne Modell… " + done + " / " + total;
      });
      if (myId !== attrLoadSeq) return;
      App.attrChoices = choices;
      hint.textContent = App.attrChoices.length + " Attribute im Modell — tippen zum Filtern.";
    }
    const wrap = $("cfg-attr-rows");
    const openBox = wrap && wrap.querySelector(".combo-results:not(.hidden)");
    if (openBox) {
      const rowEl = openBox.closest(".attr-row");
      const rowInput = rowEl.querySelector(".attr-search");
      renderAttrResults(rowInput.value, Number(rowEl.getAttribute("data-idx")));
    }
  } catch (e) {
    if (myId === attrLoadSeq) hint.textContent = "Fehler: " + (e.message || e);
  } finally {
    if (myId === attrLoadSeq) App.attrLoading = false;
  }
}

// Attribute des aktuell gewählten Bauteils.
async function attrsOfSelection(sel) {
  const props = await App.api.viewer.getObjectProperties(
    sel[0].modelId, [sel[0].objectRuntimeIds[0]]);
  const choices = [];
  for (const obj of props || []) {
    for (const set of (obj.properties || obj.propertySets || [])) {
      for (const p of (set.properties || [])) {
        choices.push({ pset: set.name, attr: p.name, value: p.value });
      }
    }
  }
  return choices;
}

// Alle distinkten Attribute im Modell (Pset + Name) mit Beispielwert.
// Früh-Stop, sobald keine neuen Attribute mehr auftauchen (Namen wiederholen sich stark).
const ATTR_SCAN_CAP = 2500;
async function attrsOfModel(onProgress) {
  const modelObjs = await App.api.viewer.getObjects();
  const map = new Map(); // "pset\u0000attr" -> {pset, attr, value}
  const add = (pset, attr, value) => {
    const k = pset + "\u0000" + attr;
    if (!map.has(k)) map.set(k, { pset, attr, value });
  };
  const collect = (p) => {
    for (const set of (p.properties || p.propertySets || [])) {
      for (const pr of (set.properties || [])) add(set.name, pr.name, pr.value);
    }
  };
  let total = 0;
  for (const mo of (modelObjs || [])) total += (mo.objects || []).length;
  let scanned = 0;
  for (const mo of (modelObjs || [])) {
    const objs = mo.objects || [];
    const need = [];
    for (const o of objs) {
      if (o && o.properties) { collect(o); scanned++; }
      else if (o) need.push(o.id);
    }
    for (let i = 0; i < need.length && scanned < ATTR_SCAN_CAP; i += SCAN_CHUNK) {
      const chunk = need.slice(i, i + SCAN_CHUNK);
      const before = map.size;
      const props = await App.api.viewer.getObjectProperties(mo.modelId, chunk);
      for (const p of (props || [])) collect(p);
      scanned += chunk.length;
      if (onProgress) onProgress(Math.min(scanned, total), total);
      if (map.size === before && scanned >= 500) break; // keine neuen Attribute mehr
    }
    if (scanned >= ATTR_SCAN_CAP) break;
  }
  return [...map.values()].sort((a, b) => (a.pset + a.attr).localeCompare(b.pset + b.attr));
}

// ---------- Schlüssel-Attribut-Zeilen (eine bis drei) ----------
const MAX_KEY_ROWS = 3;

// Baut die Attributzeilen aus App.keyRows neu auf und bindet ihre Ereignisse.
function renderKeyRows() {
  const wrap = $("cfg-attr-rows");
  if (!wrap) return;
  if (!App.keyRows.length) App.keyRows = [{ pset: "", attribute: "", op: "and" }];
  let html = "";
  App.keyRows.forEach((row, i) => {
    const display = row.attribute ? (row.pset ? row.pset + " › " + row.attribute : row.attribute) : "";
    html += '<div class="attr-row" data-idx="' + i + '">';
    if (i > 0) {
      html += '<select class="attr-op" aria-label="Verknüpfung">'
        + '<option value="and"' + (row.op === "or" ? "" : " selected") + '>und</option>'
        + '<option value="or"' + (row.op === "or" ? " selected" : "") + '>oder</option>'
        + "</select>";
    }
    html += '<div class="combo">'
      + '<input type="text" class="attr-search" autocomplete="off" placeholder="'
      + (i === 0 ? "Name eingeben, z. B. Stahllistennummer" : "weiteres Attribut") + '" value="' + esc(display) + '" />'
      + '<div class="combo-results hidden"></div></div>';
    // Genau ein Icon-Knopf am Zeilenende: erste Zeile fuegt hinzu, weitere entfernen.
    if (i > 0) {
      html += '<button class="iconbtn attr-remove" type="button" title="Attribut entfernen" aria-label="Attribut entfernen">×</button>';
    } else if (App.keyRows.length < MAX_KEY_ROWS) {
      html += '<button class="iconbtn attr-add" type="button" title="Attribut hinzufügen" aria-label="Attribut hinzufügen">+</button>';
    }
    html += "</div>";
    // Optionales Panel "Abgleich anpassen" je gewaehltem Attribut.
    if (row.attribute) html += transformPanelHTML(row, i);
  });
  wrap.innerHTML = html;
  bindKeyRows();
}

// Beispielwert eines Attributs aus dem letzten Modell-/Bauteil-Scan.
function rowSampleValue(row) {
  if (!row || !row.attribute) return "";
  const c = (App.attrChoices || []).find(
    (x) => x.attr === row.attribute && (x.pset || "") === (row.pset || ""));
  return c && c.value != null ? String(c.value) : "";
}

// Vorschautext: was beim Abgleich gesucht wird.
function previewText(row) {
  const val = rowSampleValue(row);
  if (!val) return "Bauteil im Modell wählen, um eine Vorschau zu sehen.";
  const t = row.transform || null;
  const needle = applyTransform(val, t);
  if (!needle) return "Aus „" + val + "“ ergibt sich kein Suchbegriff.";
  return "Aus „" + val + "“ wird „" + needle + "“"
    + (transformIgnoresSep(t) ? " · Trennzeichen egal" : "");
}

// Verwirft eine leere Umformung (alles Standard) wieder ganz.
function normalizeTransform(row) {
  const t = row.transform;
  if (!t) return;
  const hasSeg = Array.isArray(t.segments) && t.segments.length;
  if (!hasSeg && !t.regex && !t.ignoreSep) row.transform = undefined;
  else if (!hasSeg && Array.isArray(t.segments)) delete t.segments;
}

// Aus-/abwaehlen eines Wert-Segments (Chip) fuer Zeile idx.
function toggleSeg(idx, si) {
  const row = App.keyRows[idx];
  if (!row) return;
  const total = splitSegments(rowSampleValue(row)).length;
  let cur = (row.transform && Array.isArray(row.transform.segments))
    ? row.transform.segments.slice()
    : Array.from({ length: total }, (_, k) => k); // null = alle gewaehlt
  cur = cur.includes(si) ? cur.filter((x) => x !== si) : cur.concat(si).sort((a, b) => a - b);
  row.transform = row.transform || {};
  if (cur.length >= total) delete row.transform.segments; // alle -> Standard
  else row.transform.segments = cur;
  normalizeTransform(row);
}

// HTML des Umform-Panels einer Zeile.
function transformPanelHTML(row, idx) {
  const val = rowSampleValue(row);
  const segs = splitSegments(val);
  const t = row.transform || null;
  const sel = (t && Array.isArray(t.segments)) ? new Set(t.segments) : null; // null = alle
  let chips = "";
  if (segs.length) {
    chips = '<div class="seg-chips">'
      + segs.map((s, si) => '<button type="button" class="seg-chip'
        + ((!sel || sel.has(si)) ? " on" : "") + '" data-seg="' + si + '">' + esc(s) + "</button>").join("")
      + "</div>";
  } else {
    chips = '<p class="hint">Bauteil im Modell wählen, um den Wert in Bausteine zu zerlegen.</p>';
  }
  const ign = !!(t && t.ignoreSep);
  const rx = (t && t.regex) ? t.regex : "";
  return '<div class="attr-xform" data-idx="' + idx + '">'
    + '<details class="xform"' + (t ? " open" : "") + '>'
    + '<summary>Abgleich anpassen</summary>'
    + '<div class="xform-body">'
    + '<p class="hint">Alle Teile sind gewählt (blau = wird gesucht). Klicke die Teile ab, die nicht im Dateinamen stehen.</p>'
    + chips
    + '<label class="xform-check"><input type="checkbox" class="xform-ign"'
    + (ign ? " checked" : "") + ' /> Trennzeichen ignorieren (z. B. „/“ = „_“)</label>'
    + '<p class="xform-preview">' + esc(previewText(row)) + "</p>"
    + '<details class="xform-adv"' + (rx ? " open" : "") + '>'
    + '<summary>Erweitert</summary>'
    + '<label for="xform-rx-' + idx + '">Eigenes Muster (Regex) — überschreibt die Bausteine</label>'
    + '<input type="text" class="xform-regex" id="xform-rx-' + idx + '" autocomplete="off"'
    + ' placeholder="z. B. (\\d+\\.\\d+)$" value="' + esc(rx) + '" />'
    + "</details>"
    + "</div></details></div>";
}

function bindKeyRows() {
  const wrap = $("cfg-attr-rows");
  wrap.querySelectorAll(".attr-row").forEach((rowEl) => {
    const idx = Number(rowEl.getAttribute("data-idx"));
    const input = rowEl.querySelector(".attr-search");
    const box = rowEl.querySelector(".combo-results");
    let t;
    input.addEventListener("focus", async () => {
      App.activeRow = idx;
      if (!App.attrChoices.length && !App.attrLoading) await loadAttributeChoices();
      renderAttrResults(input.value, idx);
    });
    input.addEventListener("input", () => {
      App.activeRow = idx;
      clearTimeout(t);
      t = setTimeout(() => renderAttrResults(input.value, idx), 100);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => box.classList.add("hidden"), 150);
    });
    const op = rowEl.querySelector(".attr-op");
    if (op) op.addEventListener("change", () => { if (App.keyRows[idx]) App.keyRows[idx].op = op.value; });
    const rm = rowEl.querySelector(".attr-remove");
    if (rm) rm.addEventListener("click", () => { App.keyRows.splice(idx, 1); renderKeyRows(); });
    const add = rowEl.querySelector(".attr-add");
    if (add) add.addEventListener("click", addAttrRow);
  });
  bindTransformPanels();
}

// Bindet die Chips/Checkbox/Regex der "Abgleich anpassen"-Panels (in-place,
// damit der offene Zustand erhalten bleibt).
function bindTransformPanels() {
  const wrap = $("cfg-attr-rows");
  wrap.querySelectorAll(".attr-xform").forEach((panel) => {
    const idx = Number(panel.getAttribute("data-idx"));
    const preview = panel.querySelector(".xform-preview");
    const refresh = () => { if (preview) preview.textContent = previewText(App.keyRows[idx]); };
    panel.querySelectorAll(".seg-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        toggleSeg(idx, Number(chip.getAttribute("data-seg")));
        chip.classList.toggle("on");
        refresh();
      });
    });
    const ign = panel.querySelector(".xform-ign");
    if (ign) ign.addEventListener("change", () => {
      const row = App.keyRows[idx]; if (!row) return;
      row.transform = row.transform || {};
      row.transform.ignoreSep = ign.checked;
      normalizeTransform(row);
      refresh();
    });
    const rx = panel.querySelector(".xform-regex");
    if (rx) rx.addEventListener("input", () => {
      const row = App.keyRows[idx]; if (!row) return;
      row.transform = row.transform || {};
      const v = rx.value.trim();
      if (v) row.transform.regex = v; else delete row.transform.regex;
      normalizeTransform(row);
      refresh();
    });
  });
}

function addAttrRow() {
  if (App.keyRows.length >= MAX_KEY_ROWS) return;
  App.keyRows.push({ pset: "", attribute: "", op: "and" });
  renderKeyRows();
  const inputs = $("cfg-attr-rows").querySelectorAll(".attr-search");
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}

// Filtert die gecachten Attribute live und zeigt sie unter der Zeile idx, nach Pset gruppiert.
function renderAttrResults(filter, idx) {
  if (idx == null) idx = App.activeRow || 0;
  const wrap = $("cfg-attr-rows");
  const rowEl = wrap && wrap.querySelector('.attr-row[data-idx="' + idx + '"]');
  if (!rowEl) return;
  const box = rowEl.querySelector(".combo-results");
  const input = rowEl.querySelector(".attr-search");
  const f = String(filter || "").toLowerCase().trim();
  if (!App.attrChoices.length) {
    box.innerHTML = '<div class="combo-empty">Keine Attribute gefunden. ↻ neu laden oder ein Bauteil im Modell wählen.</div>';
    box.classList.remove("hidden");
    return;
  }
  // Attribute, die andere Zeilen schon nutzen, nicht noch einmal anbieten.
  const used = new Set();
  App.keyRows.forEach((r, i) => {
    if (i !== idx && r && r.attribute) used.add((r.pset || "") + "\u0000" + r.attribute);
  });
  const matches = App.attrChoices.filter((c) =>
    !used.has((c.pset || "") + "\u0000" + c.attr)
    && (!f || c.attr.toLowerCase().includes(f) || c.pset.toLowerCase().includes(f)));
  if (!matches.length) {
    box.innerHTML = '<div class="combo-empty">Keine Treffer.</div>';
    box.classList.remove("hidden");
    return;
  }
  const groups = {};
  for (const m of matches.slice(0, 80)) (groups[m.pset] = groups[m.pset] || []).push(m);
  let html = "";
  for (const pset of Object.keys(groups)) {
    html += '<div class="combo-group">' + esc(pset) + "</div>";
    for (const m of groups[pset]) {
      const val = m.value != null ? String(m.value) : "";
      html += '<div class="combo-item" data-pset="' + esc(m.pset) + '" data-attr="' + esc(m.attr) + '">'
        + esc(m.attr)
        + (val ? ' <span class="val">· ' + esc(val.slice(0, 32)) + "</span>" : "")
        + "</div>";
    }
  }
  box.innerHTML = html;
  box.classList.remove("hidden");
  box.querySelectorAll(".combo-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault(); // vor dem blur des Inputs feuern
      const op = App.keyRows[idx] ? App.keyRows[idx].op : "and";
      App.keyRows[idx] = { pset: el.getAttribute("data-pset"), attribute: el.getAttribute("data-attr"), op };
      input.value = App.keyRows[idx].pset + " › " + App.keyRows[idx].attribute;
      box.classList.add("hidden");
      renderKeyRows(); // Panel "Abgleich anpassen" fuer das neue Attribut zeigen
    });
  });
}

// Liest das Formular aus und baut die Regel. Gibt null zurück, wenn etwas fehlt.
function buildRuleFromForm() {
  const sh = $("save-hint");
  const folder = App.selectedFolderId;
  const seen = new Set();
  const keys = (App.keyRows || [])
    .filter((r) => r && r.attribute)
    .filter((r) => { const k = (r.pset || "") + " " + r.attribute; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r, i) => {
      const k = { pset: r.pset || "", attribute: r.attribute, op: (i > 0 && r.op === "or") ? "or" : "and" };
      if (r.transform) k.transform = r.transform;
      return k;
    });
  if (!keys.length) { sh.textContent = "Bitte mindestens ein Attribut wählen."; sh.className = "hint warn"; return null; }
  if (!folder) { sh.textContent = "Bitte einen Ordner wählen."; sh.className = "hint warn"; return null; }
  return {
    keys,
    pset: keys[0].pset,        // Spiegel des ersten Attributs (Abwaertskompatibilitaet)
    attribute: keys[0].attribute,
    targetFolderId: folder,
    targetFolderName: App.selectedFolderName || "",
    matchMode: $("cfg-match").value,
    fileType: $("cfg-filetype").value,
    skipArchive: $("cfg-skiparchive").value,
  };
}

// Cache des Modell-Scans verwerfen, weil sich die wirksame Regel geändert hat.
function invalidateScan() { App.modelLists = null; App.fileObjects = null; }

// Kurze, selbst ausblendende Rückmeldung. Startet die Animation bei jedem Aufruf
// neu, damit auch ein erneuter Klick sichtbar quittiert wird.
let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  if (!t) return;
  const icon = kind === "warn" ? "⚠" : "✓";
  t.textContent = icon + "  " + msg;
  t.className = "toast " + (kind === "warn" ? "warn" : "ok");
  t.classList.remove("show");
  void t.offsetWidth; // Reflow -> Animation auch bei gleichem Text neu
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), kind === "warn" ? 4000 : 2600);
}

// Führt fn aus und zeigt am Knopf solange einen Ladezustand.
async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const prev = btn.textContent, wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> ' + label;
  try { return await fn(); }
  finally { btn.disabled = wasDisabled; btn.textContent = prev; }
}

async function onSaveScope(scope) {
  const sh = $("save-hint");
  const rule = buildRuleFromForm();
  if (!rule) return;
  const btn = $(scope === "project" ? "btn-save-project" : "btn-save-user");
  try {
    await withBusy(btn, "Speichern…", () => saveConfig(rule, scope));
    sh.textContent = ""; sh.className = "hint";
    toast(scope === "project" ? "Als Projekt-Standard gespeichert" : "Für dich gespeichert", "ok");
    invalidateScan();
    ensureFileIndex(rule.targetFolderId, true).catch(() => {});
    renderConfigScopeState();
  } catch (e) {
    sh.textContent = e.message;
    sh.className = "hint warn";
    toast("Speichern fehlgeschlagen", "warn");
  }
}

async function resetToProjectDefault() {
  const sh = $("save-hint");
  const btn = $("btn-reset-default");
  try {
    await withBusy(btn, "Zurücksetzen…", () => deleteOverride());
    sh.textContent = ""; sh.className = "hint";
    toast("Auf Projekt-Standard zurückgesetzt", "ok");
    invalidateScan();
    fillConfigForm();
    renderConfigScopeState();
    if (App.config && App.config.rules[0]) ensureFileIndex(App.config.rules[0].targetFolderId, true).catch(() => {});
  } catch (e) {
    sh.textContent = e.message;
    sh.className = "hint warn";
    toast("Zurücksetzen fehlgeschlagen", "warn");
  }
}

// Hinweis zur Herkunft der Einstellungen und Sichtbarkeit des Admin-Knopfs setzen.
function renderConfigScopeState() {
  const projBtn = $("btn-save-project");
  if (projBtn) projBtn.classList.toggle("hidden", !App.isAdmin);
  const note = $("cfg-scope-note");
  if (!note) return;
  if (App.hasOverride) {
    note.innerHTML = "Du nutzt deine eigenen Einstellungen. "
      + '<button class="linkbtn" id="btn-reset-default" type="button">Auf Projekt-Standard zurücksetzen</button>';
    const b = $("btn-reset-default");
    if (b) b.addEventListener("click", resetToProjectDefault);
  } else {
    note.textContent = "Du nutzt die Projekt-Vorgabe.";
  }
}

// ---------- Ordner-Browser ----------
let fbStack = []; // [{id, name}], letztes Element = aktueller Ordner
const FOLDER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" style="vertical-align:-3px;opacity:.6;flex:0 0 auto"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

const SEL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/>'
  + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

async function fbFetch(qs) {
  const r = await fetch("/api/browse?" + qs, { headers: { Authorization: "Bearer " + (App.token || "") } });
  if (!r.ok) throw new Error("(" + r.status + ")");
  return r.json();
}

async function openFolderBrowser() {
  $("folder-browser").classList.remove("hidden");
  $("fb-list").innerHTML = '<div class="fb-empty">lädt…</div>';
  try {
    const data = await fbFetch("projectId=" + encodeURIComponent(App.projectId));
    fbStack = [{ id: data.folderId, name: "Projekt" }];
    renderFb(data.folders);
  } catch (e) {
    $("fb-list").innerHTML = '<div class="fb-empty warn">Ordner nicht lesbar ' + esc(e.message || e) + "</div>";
  }
}

async function fbReload() {
  $("fb-list").innerHTML = '<div class="fb-empty">lädt…</div>';
  try {
    const data = await fbFetch("folderId=" + encodeURIComponent(fbStack[fbStack.length - 1].id));
    renderFb(data.folders);
  } catch (e) {
    $("fb-list").innerHTML = '<div class="fb-empty warn">Fehler ' + esc(e.message || e) + "</div>";
  }
}

function renderFb(folders) {
  $("fb-crumb").textContent = fbStack.map((s) => s.name).join(" / ");
  const list = $("fb-list");
  folders = folders || [];
  if (!folders.length) {
    list.innerHTML = '<div class="fb-empty">Keine Unterordner. Mit „Diesen Ordner wählen" bestätigen.</div>';
    return;
  }
  list.innerHTML = "";
  folders.forEach((f) => {
    const el = document.createElement("div");
    el.className = "fb-folder";
    el.innerHTML = FOLDER_ICON + " <span>" + esc(f.name) + "</span>";
    el.addEventListener("click", () => { fbStack.push({ id: f.id, name: f.name }); fbReload(); });
    list.appendChild(el);
  });
}

function fbUp() { if (fbStack.length > 1) { fbStack.pop(); fbReload(); } }
function fbClose() { $("folder-browser").classList.add("hidden"); }
function fbChoose() {
  const cur = fbStack[fbStack.length - 1];
  App.selectedFolderId = cur.id;
  App.selectedFolderName = fbStack.map((s) => s.name).join(" / ");
  $("folder-display").textContent = App.selectedFolderName;
  fbClose();
}

// ---------- Ansicht wechseln ----------
const APP_VERSION = "1.0";
const VIEWS = ["runtime", "config", "help", "about"];
function setView(name) {
  App.view = name;
  for (const v of VIEWS) $("view-" + v).classList.toggle("hidden", v !== name);
}

function showRuntime() {
  setView("runtime");
  refreshRuntime();
}

function showHelp() { setView("help"); }
function showAbout() {
  const v = (App.version && App.version.version) ? App.version.version : APP_VERSION;
  $("about-version").textContent = v;
  const built = (App.version && App.version.builtAt) ? fmtDate(App.version.builtAt) : "";
  $("about-built").textContent = built ? " (Stand " + built + ")" : "";
  $("about-year").textContent = new Date().getFullYear();
  setView("about");
}

// Formular aus der wirksamen Konfig (effective) füllen.
function fillConfigForm() {
  if (!(App.config && App.config.rules[0])) {
    App.keyRows = [{ pset: "", attribute: "", op: "and" }];
    renderKeyRows();
    return;
  }
  const r = App.config.rules[0];
  App.selectedFolderId = r.targetFolderId || null;
  App.selectedFolderName = r.targetFolderName || r.targetFolderId || "";
  $("folder-display").textContent = App.selectedFolderName || "— kein Ordner gewählt —";
  $("cfg-match").value = r.matchMode || "exact";
  $("cfg-filetype").value = r.fileType || "all";
  $("cfg-skiparchive").value = r.skipArchive || "1";
  const keys = ruleKeys(r);
  App.keyRows = keys.length
    ? keys.map((k, i) => ({ pset: k.pset || "", attribute: k.attribute || "", op: (i > 0 && k.op === "or") ? "or" : "and", transform: k.transform || undefined }))
    : [{ pset: "", attribute: "", op: "and" }];
  renderKeyRows();
}

function showConfig() {
  setView("config");
  fillConfigForm();
  renderConfigScopeState();
  // Attribute vorab im Hintergrund laden -> Filtern reagiert danach sofort.
  // Danach die Zeilen einmal neu zeichnen, damit die Wert-Bausteine/Vorschau
  // erscheinen — aber nur, wenn gerade niemand tippt oder eine Liste offen ist.
  loadAttributeChoices().then(() => {
    const wrap = $("cfg-attr-rows");
    const openBox = wrap && wrap.querySelector(".combo-results:not(.hidden)");
    const active = document.activeElement;
    const typing = active && active.classList && active.classList.contains("attr-search");
    if (!openBox && !typing) renderKeyRows();
  });
}

function bindUI() {
  $("update-reload").addEventListener("click", () => location.reload());
  $("update-close").addEventListener("click", () => $("update-bar").classList.add("hidden"));
  $("btn-lookup").addEventListener("click", () => refreshRuntime(true));
  $("btn-save-user").addEventListener("click", () => onSaveScope("user"));
  $("btn-save-project").addEventListener("click", () => onSaveScope("project"));
  $("btn-settings").addEventListener("click", showConfig);
  $("btn-help").addEventListener("click", showHelp);
  $("btn-back").addEventListener("click", showRuntime);
  $("btn-help-back").addEventListener("click", showRuntime);
  $("btn-about-back").addEventListener("click", showRuntime);
  $("lnk-cfg-help").addEventListener("click", showHelp);
  $("lnk-cfg-about").addEventListener("click", showAbout);
  $("lnk-help-about").addEventListener("click", showAbout);
  $("lnk-about-help").addEventListener("click", showHelp);

  // Klick auf „← Alle Listen" (per Delegation, da Inhalt dynamisch ist)
  $("runtime-out").addEventListener("click", (e) => {
    const sel = e.target.closest(".js-select");
    if (sel) { selectObjectsForFile(sel.getAttribute("data-fileid")); return; }
    if (e.target.closest(".js-all")) showModelLists();
  });

  $("btn-attr-reload").addEventListener("click", async () => {
    await loadAttributeChoices(true);
    const wrap = $("cfg-attr-rows");
    const rowEl = wrap.querySelector('.attr-row[data-idx="' + (App.activeRow || 0) + '"]') || wrap.querySelector(".attr-row");
    if (rowEl) renderAttrResults(rowEl.querySelector(".attr-search").value, Number(rowEl.getAttribute("data-idx")));
  });

  $("btn-pick-folder").addEventListener("click", openFolderBrowser);
  $("fb-up").addEventListener("click", fbUp);
  $("fb-close").addEventListener("click", fbClose);
  $("fb-choose").addEventListener("click", fbChoose);
}

// ---------- Helfer ----------
function card(inner) { return '<div class="card">' + inner + "</div>"; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

