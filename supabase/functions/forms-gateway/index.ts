// Edge Function: forms-gateway
// Puerta de servidor para las tablas de formularios con PII (DNI, datos de
// clientes). Con RLS prendido, la anon key del navegador ya NO puede leer estas
// tablas: las lecturas/escrituras del STAFF pasan por acá autenticadas con la
// firma HMAC del tga_session (la cookie firmada del SSO), y se hacen con
// service_role. Así se corta el volcado masivo sin romper el panel ni los forms.
//
// Acciones de STAFF (exigen sesión firmada + rol de panel):
//   list-prendas / save-prenda / delete-prenda   → prendas_informes
//   list-forms   → lista vwfs/f01/ahorro (panel + paneles admin de index/ahorro);
//                  en F01/ahorro completa el vendedor faltante desde Oversoft
//                  (secrets OVERSOFT_URL / OVERSOFT_KEY, réplica solo lectura)
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

// ─── Vendedor automático del F01 / Plan de Ahorro desde Oversoft ───
// El vendedor casi nunca se carga a mano en el panel. Oversoft lo sabe: el
// cliente (por DNI o CUIT/CUIL) tiene una preventa con vendedorid. Al listar
// F01/ahorro, los que no tienen vendedor se buscan en la réplica (solo lectura)
// y se GRABAN con el vendedor de la preventa más cercana a la fecha del form:
// una vez cargado no se vuelve a consultar. Los VWFS lo heredan de su F01 por
// trigger en la base (formularios_vwfs.f01_id), no pasan por acá.
// Mapa vendedorid de Oversoft → nombre EXACTO de la lista VENDEDORES del panel.
const OV_VENDEDORES: Record<number, string> = {
  3: "Daniel López",
  5: "José Castro",
  6: "Antonio Loisi",
  15: "TG — Ventas de Gerencia", // "Gonzalez Fernando" en Oversoft
  22: "TG — Ventas de Gerencia", // "T.G." en Oversoft
  24: "Marta Castro",
  52: "Jorge Fazzini",
  226: "Julián Naddeo",
  260: "Inés Alonso",
  289: "Gisela Buena",
  292: "Tomas Bandiera",
};
const AUTO_VEND_DIAS = 120; // solo forms recientes: los viejos sin match no se re-consultan en cada listado
const AUTO_VEND_ANTES = 60; // preventa hasta 60 días antes del form…
const AUTO_VEND_DESPUES = 30; // …o hasta 30 después (la PV a veces se arma después)
const DIA_MS = 86_400_000;

function ovBase(): string | null {
  const raw = (Deno.env.get("OVERSOFT_URL") || "").replace(/\/+$/, "");
  if (!raw || !Deno.env.get("OVERSOFT_KEY")) return null;
  return raw.endsWith("/rest/v1") ? raw : raw + "/rest/v1";
}

async function ovGet(base: string, path: string): Promise<any[]> {
  const key = Deno.env.get("OVERSOFT_KEY")!;
  const r = await fetch(`${base}/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Oversoft HTTP ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// Trae en lotes (los in.(...) largos revientan la URL).
async function ovIn(base: string, tabla: string, select: string, col: string, vals: string[], quote = false) {
  const out: any[] = [];
  for (let i = 0; i < vals.length; i += 100) {
    const lote = vals.slice(i, i + 100).map((v) => (quote ? `"${v.replace(/"/g, "")}"` : v));
    out.push(...await ovGet(base, `${tabla}?select=${select}&${col}=in.(${encodeURIComponent(lote.join(","))})`));
  }
  return out;
}

const soloDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const cuitFmt = (d: string) => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;

// DNIs y CUIT/CUIL (con guiones, como los guarda Oversoft) de un F01/ahorro.
function clavesForm(r: any): { dnis: Set<string>; cuits: Set<string> } {
  const dnis = new Set<string>();
  const cuits = new Set<string>();
  const doc = soloDigitos(r.documento);
  if (doc.length >= 7 && doc.length <= 8) dnis.add(doc.replace(/^0+/, ""));
  for (const x of [doc, soloDigitos(r.datos?.["CUIL"]), soloDigitos(r.datos?.["CUIT"])]) {
    if (x.length !== 11) continue;
    cuits.add(cuitFmt(x));
    dnis.add(x.slice(2, 10).replace(/^0+/, ""));
  }
  return { dnis, cuits };
}

// Completa (en la base y en las filas devueltas) el vendedor de los forms sin
// vendedor. Best-effort: si Oversoft falla, el listado sale igual.
async function autoVendedorOversoft(tabla: string, rows: any[]): Promise<void> {
  const base = ovBase();
  if (!base) return;
  const desde = Date.now() - AUTO_VEND_DIAS * DIA_MS;
  const pend = rows
    .filter((r) => !r.vendedor && !r.eliminado && new Date(r.created_at).getTime() >= desde)
    .map((r) => ({ r, ...clavesForm(r) }))
    .filter((p) => p.dnis.size || p.cuits.size);
  if (!pend.length) return;

  const dnis = [...new Set(pend.flatMap((p) => [...p.dnis]))];
  const cuits = [...new Set(pend.flatMap((p) => [...p.cuits]))];
  const clientes = [
    ...await ovIn(base, "clientes", "codigo,dni,cuit_cuil", "dni", dnis, true),
    ...await ovIn(base, "clientes", "codigo,dni,cuit_cuil", "cuit_cuil", cuits, true),
  ];
  const codigos = [...new Set(clientes.map((c) => String(c.codigo || "").trim()).filter(Boolean))];
  if (!codigos.length) return;
  const preventas = await ovIn(base, "preventas", "fecha,cliente,vendedorid,anulada", "cliente", codigos, true);

  // Agrupa los cambios por vendedor → un PATCH por vendedor.
  const porVendedor: Record<string, number[]> = {};
  for (const p of pend) {
    const codigosCli = new Set(
      clientes
        .filter((c) =>
          p.dnis.has(soloDigitos(c.dni).replace(/^0+/, "")) || p.cuits.has(String(c.cuit_cuil || "").trim())
        )
        .map((c) => String(c.codigo || "").trim()),
    );
    const t = new Date(p.r.created_at).getTime();
    const cand = preventas
      .filter((pv) => codigosCli.has(String(pv.cliente || "").trim()) && OV_VENDEDORES[pv.vendedorid])
      .map((pv) => ({ pv, d: new Date(pv.fecha).getTime() - t }))
      .filter((x) => x.d >= -AUTO_VEND_ANTES * DIA_MS && x.d <= AUTO_VEND_DESPUES * DIA_MS)
      // Preferir preventas vigentes y, entre ellas, la más cercana al F01.
      .sort((a, b) => (Number(!!a.pv.anulada) - Number(!!b.pv.anulada)) || (Math.abs(a.d) - Math.abs(b.d)));
    if (!cand.length) continue;
    const vend = OV_VENDEDORES[cand[0].pv.vendedorid];
    (porVendedor[vend] ||= []).push(p.r.id);
  }

  for (const [vend, ids] of Object.entries(porVendedor)) {
    // vendedor=is.null: si alguien lo asignó a mano mientras tanto, no se pisa.
    const r = await svc(`${tabla}?id=in.(${ids.join(",")})&vendedor=is.null`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ vendedor: vend }),
    });
    if (!r.ok) continue;
    for (const row of rows) if (ids.includes(row.id) && !row.vendedor) row.vendedor = vend;
  }
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
        if ((tabla === "formularios_f01" || tabla === "formularios_ahorro") && Array.isArray(rows)) {
          try {
            await autoVendedorOversoft(tabla, rows);
          } catch (e) {
            console.error("autoVendedorOversoft:", e);
          }
        }
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
