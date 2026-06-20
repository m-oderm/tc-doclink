# Dokumenten-Verknüpfer – Trimble Connect Extension

Klickt man im 3D-Modell ein Bauteil an, liest die Extension ein konfiguriertes
Attribut (den Schlüssel, z. B. eine Stahllisten-Nummer), sucht im hinterlegten
Ordner die passende Datei und öffnet sie. Pro Projekt konfigurierbar.

## Aufbau

```
manifest.json                 Extension-Manifest (in Trimble eintragen)
index.html                    Frontend (läuft im Trimble-iframe): Laufzeit + Konfig
icon.svg                      Icon
_headers                      CORS für das Manifest
functions/api/config/[projectId].js   Konfig lesen/speichern (KV)
functions/api/files.js        Proxy zur Trimble Core-API (Ordner listen)
wrangler.toml                 Pages-Konfig: KV-Binding + CORE_API_BASE
```

Frontend und Functions liegen auf derselben Pages-Domain → kein CORS zwischen
ihnen nötig. CORS braucht nur das Manifest (Trimble lädt es cross-origin).

## Deploy auf Cloudflare Pages

1. **KV anlegen**
   ```
   npx wrangler kv namespace create CONFIG_KV
   ```
   Die ausgegebene `id` in `wrangler.toml` eintragen.

2. **Region-Host setzen** – in `wrangler.toml` `CORE_API_BASE` auf den
   Region-Host eures Projekts setzen (CH/EU ≠ NA-Master, siehe unten).

3. **Deployen**
   ```
   npx wrangler pages deploy .
   ```
   (oder Git-Repo im Pages-Dashboard verbinden – Build Output Directory: `.`)

   **Build command für die Versionsanzeige:** Im Pages-Dashboard unter Settings,
   Build and deployments, das Build command auf `bash build.sh` setzen. Output-
   Verzeichnis bleibt `.`. `build.sh` schreibt dann bei jedem Deploy `version.json`
   mit dem Commit-Hash (`CF_PAGES_COMMIT_SHA`). Daraus liest das Frontend die Version
   und zeigt bei einem neuen Deploy oben eine Leiste „Neue Version verfügbar". Ohne
   gesetztes Build command fehlt `version.json` einfach, die App läuft normal weiter.
   Das Setzen ist ein manueller Schritt im Dashboard.

4. **Manifest-URL anpassen** – in `manifest.json` `url` und `icon` auf eure
   Pages-Domain setzen (`https://<name>.pages.dev/...`).

5. **Extension in Trimble installieren** – Projekt-Einstellungen → Extensions →
   Manifest-URL eintragen (`https://<name>.pages.dev/manifest.json`).

6. **Konfigurieren** – in den Extension-Einstellungen aufs Zahnrad: Bauteil im
   Modell wählen → „Attribute laden" → Schlüssel-Attribut wählen → Ordner-ID
   eintragen → speichern.

## Zwei Stellen vor dem Produktiveinsatz verifizieren

1. **CORE_API_BASE (Region):** Die Core-API ist regions-spezifisch. Projekte in
   der Schweiz/EU liegen nicht auf dem NA-Master `app.connect.trimble.com`.
   Den korrekten Region-Host über die Region-Discovery bzw. Trimble-Doku
   ermitteln und in `wrangler.toml` eintragen.

2. **Ordner-Items-Endpoint:** `functions/api/files.js` nutzt das Muster
   `GET /folders/{id}/items`. Gegen die offizielle Spec abgleichen:
   https://developer.trimble.com/docs/connect/core-api/
   Der Proxy normalisiert die Antwort defensiv (id/name/type), ggf. Feldnamen
   anpassen.

## Bewusst noch offen (nächste Iterationen)

- **Ordner-Picker** statt manueller Ordner-ID-Eingabe.
- **Datei-Vorschau/Download im Panel** statt Öffnen im neuen Tab
  (Download-URL über Core-API; Endpoint projekt-/regionsabhängig).
- **Mehrere Regeln** je Bauteiltyp (Datenmodell `rules[]` ist schon darauf ausgelegt).
- **Fallback-Mapping-Tabelle** für unsaubere Modell-Attribute.

## Datenqualität

Entscheidend ist, dass das gewählte Attribut einen brauchbaren, eindeutigen
Schlüssel enthält (nicht „ja/vorhanden") und die Dateinamen einer Konvention
folgen. Wo das nicht gegeben ist, wird eine Mapping-Tabelle nötig (siehe oben).
