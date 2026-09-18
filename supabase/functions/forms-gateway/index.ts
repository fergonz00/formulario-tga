// Edge Function: forms-gateway
// Puerta de servidor para las tablas de formularios con PII (DNI, datos de
// clientes). Con RLS prendido, la anon key del navegador ya NO puede leer estas
// tablas: las lecturas/escrituras del STAFF pasan por acá autenticadas con la
// firma HMAC del tga_session (la cookie firmada del SSO), y se hacen con
// service_role. Así se corta el volcado masivo sin romper el panel ni los forms.
//
// Acciones de STAFF (exigen sesión firmada + rol de panel):
//   list-prendas / save-prenda / delete-prenda   → prendas_informes
//   list-forms   → lista vwfs/f01/ahorro (panel + paneles admin de index/ahorro)
//   patch-forms  → edita/borra-lógico filas de vwfs/f01/ahorro por id(s)
// Acciones de CLIENTE (sin login, acotadas — flujo VWFS de continuación):
//   f01-buscar        → busca UN F01 por documento + fecha de nac. (no enumera)
//   f01-vincular-dni  → adjunta las URLs de DNI a un F01 por id

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tablas de formularios habilitadas (clave del tab → tabla real).
const FORM_TABLES: Record<string, string> = {
  vwfs: "formularios_vwfs",
  f01: "formularios_f01",
  ahorro: "formularios_ahorro",
};

// Whitelists de Prendas — espejo de panel.html. Autorización server-side.
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

// Rol de panel del usuario (owner > administracion > ventas), o null si no tiene.
// Fuente: tasador_usuarios (roles/rol); fallback a f01_admins (cuentas legacy).
async function panelRole(usuario: string): Promise<"owner" | "administracion" | "ventas" | null> {
  const u = encodeURIComponent(usuario);
  let r = await svc(`tasador_usuarios?usuario=eq.${u}&select=roles,rol,activo&limit=1`);
  let rows = await r.json().catch(() => []);
  if (Array.isArray(rows) && rows[0]) {
    const row = rows[0];
    if (row.activo === false) return null;
    const arr = Array.isArray(row.roles) && row.roles.length ? row.roles : (row.rol ? [row.rol] : []);
    if (arr.includes("f01_owner")) return "owner";
    if (arr.includes("f01_admin")) return "administracion";
    if (arr.includes("vendedor")) return "ventas";
    return null;
  }
  r = await svc(`f01_admins?usuario=eq.${u}&select=rol&limit=1`);
  rows = await r.json().catch(() => []);
  if (Array.isArray(rows) && rows[0]) {
    const rol = rows[0].rol;
    return rol === "owner" ? "owner" : rol === "administracion" ? "administracion" : "ventas";
  }
  return null;
}

// Normaliza una fecha a DD/MM/AAAA (los F01 guardan ISO; el form manda DD/MM/AAAA).
function toDdmm(s: string): string {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return t;
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

  try {
    // ─── Acciones de CLIENTE (sin login, acotadas) ───
    if (action === "f01-buscar") {
      const documento = String(body?.documento || "").trim();
      const fechaNac = toDdmm(String(body?.fechaNac || ""));
      if (!documento || !fechaNac) return json({ error: "Faltan datos" }, 400);
      const r = await svc(
        `formularios_f01?documento=eq.${encodeURIComponent(documento)}&tipo=eq.fisica&order=created_at.desc&limit=5`,
      );
      const rows = await r.json().catch(() => []);
      const match = Array.isArray(rows)
        ? rows.find((x: any) => x?.datos && x.datos["Fecha nac."] && toDdmm(x.datos["Fecha nac."]) === fechaNac)
        : null;
      return json({ match: match || null });
    }
    if (action === "f01-vincular-dni") {
      const id = String(body?.id || "").trim();
      if (!id) return json({ error: "Falta id" }, 400);
      const patch: Record<string, unknown> = {};
      if (body?.dni_frente_url) patch.dni_frente_url = body.dni_frente_url;
      if (body?.dni_dorso_url) patch.dni_dorso_url = body.dni_dorso_url;
      if (body?.dni_analisis) patch.dni_analisis = body.dni_analisis;
      if (!Object.keys(patch).length) return json({ error: "Nada para actualizar" }, 400);
      const r = await svc(`formularios_f01?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return json({ error: await r.text() }, 502);
      return json({ ok: true });
    }

    // ─── Acciones de STAFF (exigen sesión firmada) ───
    const usuario = await verifySession(body?.session);
    if (!usuario) return json({ error: "No autorizado" }, 401);

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
        const r = await svc(`prendas_informes?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        if (!r.ok) return json({ error: await r.text() }, 502);
        return json({ ok: true });
      }
      case "list-forms": {
        const role = await panelRole(usuario);
        if (!role) return json({ error: "Sin acceso al panel" }, 403);
        const tabla = FORM_TABLES[String(body?.tabla || "")];
        if (!tabla) return json({ error: "Tabla inválida" }, 400);
        const limit = Math.min(Math.max(Number(body?.limit) || 500, 1), 1000);
        const filtro = body?.incluirEliminados ? "" : "eliminado=eq.false&";
        const r = await svc(`${tabla}?${filtro}order=created_at.desc&limit=${limit}`);
        const rows = await r.json();
        return json({ rows: Array.isArray(rows) ? rows : [] });
      }
      case "get-form": {
        const role = await panelRole(usuario);
        if (!role) return json({ error: "Sin acceso al panel" }, 403);
        const tabla = FORM_TABLES[String(body?.tabla || "")];
        if (!tabla) return json({ error: "Tabla inválida" }, 400);
        const id = Number(body?.id);
        if (!Number.isFinite(id)) return json({ error: "id inválido" }, 400);
        const r = await svc(`${tabla}?id=eq.${id}&limit=1`);
        const rows = await r.json();
        return json({ rows: Array.isArray(rows) ? rows : [] });
      }
      case "patch-forms": {
        const role = await panelRole(usuario);
        if (!role) return json({ error: "Sin acceso al panel" }, 403);
        const tabla = FORM_TABLES[String(body?.tabla || "")];
        if (!tabla) return json({ error: "Tabla inválida" }, 400);
        const ids = Array.isArray(body?.ids) ? body.ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n)) : [];
        if (!ids.length) return json({ error: "Sin ids" }, 400);
        const patch = body?.patch;
        if (!patch || typeof patch !== "object") return json({ error: "Sin cambios" }, 400);
        // Borrado lógico (eliminado=true) reservado a administración/owner.
        if ("eliminado" in patch && role === "ventas") return json({ error: "Sin permiso para borrar" }, 403);
        const filtro = ids.length === 1 ? `id=eq.${ids[0]}` : `id=in.(${ids.join(",")})`;
        const r = await svc(`${tabla}?${filtro}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(patch),
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
