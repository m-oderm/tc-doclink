// GET  /api/config/:projectId  -> liest die Konfig (oder leeres Gerüst)
// PUT  /api/config/:projectId  -> speichert die Konfig
// Speicher: Cloudflare KV, gebunden als CONFIG_KV (siehe wrangler.toml / Dashboard)

export async function onRequestGet(context) {
  const { params, env } = context;
  const id = params.projectId;
  const val = await env.CONFIG_KV.get("cfg:" + id);
  const body = val || JSON.stringify({ projectId: id, rules: [] });
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

export async function onRequestPut(context) {
  const { params, env, request } = context;
  const id = params.projectId;
  const body = await request.text();

  // einfache Validierung
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) {
    return new Response('{"error":"ungültiges JSON"}', { status: 400, headers: json() });
  }
  if (!parsed || !Array.isArray(parsed.rules)) {
    return new Response('{"error":"rules[] erwartet"}', { status: 400, headers: json() });
  }

  await env.CONFIG_KV.put("cfg:" + id, JSON.stringify(parsed));
  return new Response(JSON.stringify(parsed), { headers: json() });
}

function json() { return { "Content-Type": "application/json" }; }
