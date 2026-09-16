// Edge Function: forms-gateway
// Puerta de servidor para las tablas de formularios con PII (DNI, datos de
// clientes). Con RLS prendido, la anon key del navegador ya NO puede leer estas
// tablas: las lecturas/escrituras del STAFF pasan por acá, autenticadas con la
// firma HMAC del tga_session (la misma cookie firmada del SSO), y se hacen con
// service_role. Así se corta el volcado masivo sin romper el panel.
//
// Acciones (por ahora, prendas_informes; se irán sumando f01/ahorro):
//   list-prendas   → lista informes (staff con acceso a Prendas)
//   save-prenda    → guarda un informe (staff con acceso a Prendas)
//   delete-prenda  → borra un informe (solo owners de Prendas)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Whitelists — espejo de las del panel (panel.html). Autorización server-side.
const PRENDAS_USERS = ["alaso", "cgonzalez", "fgonzalez", "fngonzalez", "megerez", "mgerez", "vfernandez", "mlubrano"];
const PRENDAS_DELETE_USERS = ["mlubrano", "fngonzalez"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// PostgREST con service_role (bypasea RLS).
function svc(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
}

let _secretCache: string | null = null;
async function getSecret(): Promise<string> {
  if (_secretCache) return _secretCache;
  const r = await svc("app_config?clave=eq.tga_session_secret&select=valor");
  const rows = await r.json().catch(() => []);
  _secretCache = (Array.isArray(rows) && rows[0]?.valor) || "";
  return _secretCache;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparación en tiempo constante (evita timing attacks sobre la firma).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verifica la firma del tga_session. Devuelve el usuario si es válida, o null.
async function verifySession(sess: any): Promise<string | null> {
  if (!sess || typeof sess !== "object") return null;
  const usuario = String(sess.usuario || "").trim().toLowerCase();
  const exp = Number(sess.session_exp);
  const sig = String(sess.session_sig || "");
  if (!usuario || !exp || !sig) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null; // vencida
  const secret = await getSecret();
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${usuario}.${exp}`));
  return timingSafeEqual(toHex(mac), sig) ? usuario : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const action = String(body?.action || "");
  const usuario = await verifySession(body?.session);
  // Todas las acciones actuales son de staff → exigen sesión firmada válida.
  if (!usuario) return json({ error: "No autorizado" }, 401);

  try {
    switch (action) {
      case "list-prendas": {
        if (!PRENDAS_USERS.includes(usuario)) return json({ error: "Sin acceso a Prendas" }, 403);
        const r = await svc("prendas_informes?select=*&order=created_at.desc&limit=500");
        const rows = await r.json();
        return json({ rows: Array.isArray(rows) ? rows : [] });
      }
      case "save-prenda": {
        if (!PRENDAS_USERS.includes(usuario)) return json({ error: "Sin acceso a Prendas" }, 403);
        const v = body?.payload;
        if (!v || typeof v !== "object") return json({ error: "Falta el informe" }, 400);
        // guardado_por lo fija el servidor con la identidad firmada, no el cliente.
        const payload = {
          guardado_por: usuario,
          deudor_nombre: String(v.deudor_nombre || ""),
          deudor_dni: String(v.deudor_dni || ""),
          estado: v.estado === "aprobado" ? "aprobado" : "rechazado",
          aprobado: v.aprobado === true,
          veredicto: v.veredicto ?? v,
        };
        const r = await svc("prendas_informes", {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) return json({ error: await r.text() }, 502);
        return json({ ok: true });
      }
      case "delete-prenda": {
        if (!PRENDAS_DELETE_USERS.includes(usuario)) return json({ error: "Sin permiso para borrar" }, 403);
        const id = Number(body?.id);
        if (!Number.isFinite(id)) return json({ error: "id inválido" }, 400);
        const r = await svc(`prendas_informes?id=eq.${id}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
        if (!r.ok) return json({ error: await r.text() }, 502);
        return json({ ok: true });
      }
      default:
        return json({ error: "Acción desconocida" }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
