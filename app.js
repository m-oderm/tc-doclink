"use strict";

const App = {
  api: null,
  token: null,
  projectId: null,
  config: null,        // wirksame Konfig (effective): { projectId, rules: [ {pset, attribute, targetFolderId, matchMode} ] }
  hasOverride: false,  // true, wenn eine persoenliche Ueberschreibung gespeichert ist
  isAdmin: false,      // true, wenn der Benutzer Projekt-Admin ist (Projekt-Standard speicherbar)
  view: "runtime",
  attrChoices: [],     // zwischengespeicherte Attribute (Bauteil oder ganzes Modell)
  attrLoading: false,  // verhindert parallele Ladevorgänge der Attribut-Auswahl
  selectedAttr: null,  // { pset, attribute }
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
  bindUI();
  showRuntime();

  // Datei-Index im Hintergrund vorladen -> erster Abruf ist schnell
  if (App.config && App.config.rules[0]) {
    ensureFileIndex(App.config.rules[0].targetFolderId).catch(() => {});
  }
})();

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
  out.innerHTML = card('<span class="spinner"></span> &nbsp;Scanne Modell…');
  try {
    const files = await ensureFileIndex(rule.targetFolderId);
    const modelObjs = await App.api.viewer.getObjects();
    let total = 0;
    for (const mo of (modelObjs || [])) total += (mo.objects || []).length;

    const keys = new Set();
    const keyObjs = new Map(); // Wert -> [{ modelId, runtimeId }] (für Modell-Auswahl)
    const noteObj = (v, modelId, runtimeId) => {
      keys.add(v);
      if (runtimeId == null) return;
      if (!keyObjs.has(v)) keyObjs.set(v, []);
      keyObjs.get(v).push({ modelId, runtimeId });
    };
    let scanned = 0;
    for (const mo of (modelObjs || [])) {
      const objs = mo.objects || [];
      const need = [];
      for (const o of objs) {
        if (o && o.properties) {                 // Properties evtl. schon dabei
          const v = extractValue([o], rule.pset, rule.attribute);
          if (v) noteObj(v, mo.modelId, o.id);
          scanned++;
        } else if (o) {
          need.push(o.id);
        }
      }
      for (let i = 0; i < need.length; i += SCAN_CHUNK) {
        const chunk = need.slice(i, i + SCAN_CHUNK);
        const props = await App.api.viewer.getObjectProperties(mo.modelId, chunk);
        for (const p of (props || [])) {
          const v = extractValue([p], rule.pset, rule.attribute);
          if (v) noteObj(v, mo.modelId, p.id);
        }
        scanned += chunk.length;
        out.innerHTML = card('<span class="spinner"></span> &nbsp;Scanne Modell… ' + scanned + " / " + total);
      }
    }

    // Genauigkeit aus der Mehrheit der Modellwerte ableiten (Ausreisser/Float-Rauschen normalisieren)
    App.attrDecimals = modalDecimals([...keys]);

    // im Modell vorkommende Werte -> passende Dateien (nach Datei dedupliziert)
    const seen = new Set();
    const result = [];
    const fileObjects = new Map(); // fileId -> [{ modelId, runtimeId }]
    for (const key of keys) {
      const matches = matchAllInIndex(files, key, rule.matchMode, rule.fileType);
      const objs = keyObjs.get(key) || [];
      for (const file of matches) {
        if (!fileObjects.has(file.id)) fileObjects.set(file.id, []);
        const arr = fileObjects.get(file.id);
        for (const o of objs) arr.push(o);
        if (!seen.has(file.id)) { seen.add(file.id); result.push({ key, file }); }
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
    const props = await App.api.viewer.getObjectProperties(sel[0].modelId, [sel[0].objectRuntimeIds[0]]);
    const key = extractValue(props, rule.pset, rule.attribute);

    if (!key) {
      out.innerHTML = card('<div class="warn">Kein Schlüssel im Attribut <b>'
        + esc(rule.pset) + " › " + esc(rule.attribute) + "</b> an diesem Bauteil.</div>" + backLink());
      return;
    }
    const hits = await findFiles(rule.targetFolderId, key, rule.matchMode, rule.fileType);
    if (!hits.length) {
      out.innerHTML = card('<div class="warn">Keine Liste zu Schlüssel '
        + '<span class="key">' + esc(displayKey(key)) + "</span> gefunden.</div>" + backLink());
      return;
    }
    showResults(key, hits);
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

function matchAllInIndex(files, key, matchMode, fileType) {
  const n = (s) => String(s || "").toLowerCase();
  const stripExt = (s) => String(s || "").replace(/\.[^.]+$/, "");
  const cands = keyCandidates(key).map(n);
  const pool = files.filter((f) => fileAllowed(f.name, fileType));
  if (matchMode === "contains") {
    return pool.filter((f) => cands.some((c) => c && n(f.name).includes(c)));
  }
  const exact = pool.filter((f) => cands.some((c) => c && n(stripExt(f.name)) === c));
  if (exact.length) return exact;
  return pool.filter((f) => cands.some((c) => c && n(f.name).includes(c)));
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

async function findFiles(folderId, key, matchMode, fileType) {
  let files = await ensureFileIndex(folderId);
  let hits = matchAllInIndex(files, key, matchMode, fileType);
  if (!hits.length) {
    // evtl. neu hinzugekommene Datei -> Index einmal frisch laden und nochmal suchen
    files = await ensureFileIndex(folderId, true);
    hits = matchAllInIndex(files, key, matchMode, fileType);
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
    const box = $("cfg-attr-results");
    if (box && !box.classList.contains("hidden")) renderAttrResults($("cfg-attr-search").value);
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

// Filtert die gecachten Attribute live und zeigt sie nach Pset gruppiert.
function renderAttrResults(filter) {
  const box = $("cfg-attr-results");
  const f = String(filter || "").toLowerCase().trim();
  if (!App.attrChoices.length) {
    box.innerHTML = '<div class="combo-empty">Keine Attribute gefunden. ↻ neu laden oder ein Bauteil im Modell wählen.</div>';
    box.classList.remove("hidden");
    return;
  }
  const matches = App.attrChoices.filter((c) =>
    !f || c.attr.toLowerCase().includes(f) || c.pset.toLowerCase().includes(f));
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
      App.selectedAttr = { pset: el.getAttribute("data-pset"), attribute: el.getAttribute("data-attr") };
      $("cfg-attr-search").value = App.selectedAttr.pset + " › " + App.selectedAttr.attribute;
      box.classList.add("hidden");
    });
  });
}

// Liest das Formular aus und baut die Regel. Gibt null zurück, wenn etwas fehlt.
function buildRuleFromForm() {
  const sh = $("save-hint");
  const folder = App.selectedFolderId;
  if (!App.selectedAttr) { sh.textContent = "Bitte ein Attribut wählen."; sh.className = "hint warn"; return null; }
  if (!folder) { sh.textContent = "Bitte einen Ordner wählen."; sh.className = "hint warn"; return null; }
  return {
    pset: App.selectedAttr.pset,
    attribute: App.selectedAttr.attribute,
    targetFolderId: folder,
    targetFolderName: App.selectedFolderName || "",
    matchMode: $("cfg-match").value,
    fileType: $("cfg-filetype").value,
    skipArchive: $("cfg-skiparchive").value,
  };
}

// Cache des Modell-Scans verwerfen, weil sich die wirksame Regel geändert hat.
function invalidateScan() { App.modelLists = null; App.fileObjects = null; }

async function onSaveScope(scope) {
  const sh = $("save-hint");
  const rule = buildRuleFromForm();
  if (!rule) return;
  try {
    await saveConfig(rule, scope);
    sh.textContent = scope === "project" ? "Als Projekt-Standard gespeichert." : "Für dich gespeichert.";
    sh.className = "hint ok";
    invalidateScan();
    ensureFileIndex(rule.targetFolderId, true).catch(() => {});
    renderConfigScopeState();
  } catch (e) {
    sh.textContent = e.message;
    sh.className = "hint warn";
  }
}

async function resetToProjectDefault() {
  const sh = $("save-hint");
  try {
    await deleteOverride();
    sh.textContent = "Auf Projekt-Standard zurückgesetzt.";
    sh.className = "hint ok";
    invalidateScan();
    fillConfigForm();
    renderConfigScopeState();
    if (App.config && App.config.rules[0]) ensureFileIndex(App.config.rules[0].targetFolderId, true).catch(() => {});
  } catch (e) {
    sh.textContent = e.message;
    sh.className = "hint warn";
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
  $("about-version").textContent = APP_VERSION;
  $("about-year").textContent = new Date().getFullYear();
  setView("about");
}

// Formular aus der wirksamen Konfig (effective) füllen.
function fillConfigForm() {
  if (!(App.config && App.config.rules[0])) return;
  const r = App.config.rules[0];
  App.selectedFolderId = r.targetFolderId || null;
  App.selectedFolderName = r.targetFolderName || r.targetFolderId || "";
  $("folder-display").textContent = App.selectedFolderName || "— kein Ordner gewählt —";
  $("cfg-match").value = r.matchMode || "exact";
  $("cfg-filetype").value = r.fileType || "all";
  $("cfg-skiparchive").value = r.skipArchive || "1";
  App.selectedAttr = { pset: r.pset, attribute: r.attribute };
  $("cfg-attr-search").value = r.pset + " › " + r.attribute;
}

function showConfig() {
  setView("config");
  fillConfigForm();
  renderConfigScopeState();
  // Attribute vorab im Hintergrund laden -> Filtern reagiert danach sofort
  loadAttributeChoices();
}

function bindUI() {
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

  const searchEl = $("cfg-attr-search");
  let t;
  searchEl.addEventListener("focus", async () => {
    if (!App.attrChoices.length && !App.attrLoading) await loadAttributeChoices();
    renderAttrResults(searchEl.value);
  });
  searchEl.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => renderAttrResults(searchEl.value), 100);
  });
  searchEl.addEventListener("blur", () => {
    setTimeout(() => $("cfg-attr-results").classList.add("hidden"), 150);
  });
  $("btn-attr-reload").addEventListener("click", async () => {
    await loadAttributeChoices(true);
    renderAttrResults(searchEl.value);
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

