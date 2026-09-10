// Supabase Edge Function: analizar-dni
// Recibe URLs del DNI frente y dorso + datos del datero.
// Llama a Claude API con vision para:
//   1) Evaluar calidad de ambas imagenes (legibilidad, blur, bordes)
//   2) Extraer los datos del DNI
//   3) Transcribir la MRZ del dorso y reportar senales de manipulacion
//   4) Comparar contra los datos del datero con tolerancia fuzzy en direccion
// Despues corre el PERITAJE DE AUTENTICIDAD (ver _shared/peritaje-dni.ts):
// cruza frente contra MRZ, valida CUIL y perita el archivo. Si da rojo, el
// documento no se puede tomar.
// Devuelve JSON estructurado con resultado.
//
// Deploy:
//   supabase functions deploy analizar-dni --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

// deno-lint-ignore-file no-explicit-any

import {
  forenseArchivo,
  peritar,
  type ForenseArchivo,
} from "../_shared/peritaje-dni.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "../_shared/prompt-dni.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Levenshtein distance normalizada (0..1, donde 1 = identicas).
function similitud(a: string, b: string): number {
  const s1 = (a || "").trim().toLowerCase();
  const s2 = (b || "").trim().toLowerCase();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Normaliza DNI a solo digitos (saca puntos, espacios).
function normDni(s: string): string {
  return (s || "").replace(/\D/g, "");
}

// Normaliza texto generico: lowercase, sin tildes, trim, espacios simples.
function normTxt(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchImageAsBase64(url: string): Promise<{
  data: string;
  mediaType: string;
  bytes: Uint8Array;
}> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`No pude descargar imagen ${url}: ${resp.status}`);
  }
  const mediaType = resp.headers.get("content-type") || "image/jpeg";
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length))
    );
  }
  const data = btoa(binary);
  return { data, mediaType, bytes };
}

// Deja constancia del peritaje en `dni_peritajes`. Es best-effort: si falla,
// el analisis del DNI tiene que devolver igual, no se corta por el log.
async function registrarPeritaje(fila: Record<string, unknown>): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/dni_peritajes`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fila),
    });
  } catch (_e) {
    /* no bloquea */
  }
}

// Dispara el aviso por WhatsApp de los peritajes rojos que quedaron pendientes.
// Es fire-and-forget: si falla, el pg_cron de respaldo lo reintenta.
async function dispararAviso(): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(`${url}/functions/v1/notify-dni-adulterado`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch (_e) {
    /* el aviso no puede tumbar el peritaje */
  }
}

// Baja el archivo TAL CUAL lo subio el cliente (sin pasar por el canvas del
// navegador) para poder peritarlo. Si no esta disponible devolvemos null: el
// peritaje sigue corriendo con los chequeos de MRZ y CUIL, que son los fuertes.
async function forenseDeUrl(url: string | undefined | null): Promise<ForenseArchivo | null> {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") || "";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return await forenseArchivo(bytes, mime);
  } catch (_e) {
    return null;
  }
}


Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    const body = await req.json();
    const {
      dni_frente_url,
      dni_dorso_url,
      // URLs del archivo TAL CUAL lo eligio el usuario, sin pasar por el canvas
      // del navegador. Son las unicas que sirven para peritar el archivo
      // (dimensiones reales, EXIF, C2PA). Opcionales: si no vienen, el peritaje
      // corre igual con los chequeos de MRZ y CUIL.
      dni_frente_orig_url,
      dni_dorso_orig_url,
      // true cuando el documento llego dentro de un PDF (pierde toda la
      // evidencia forense del archivo original).
      origen_pdf,
      datero,
    }: {
      dni_frente_url: string;
      dni_dorso_url: string;
      dni_frente_orig_url?: string;
      dni_dorso_orig_url?: string;
      origen_pdf?: boolean;
      datero: Record<string, string>;
    } = body;

    if (!dni_frente_url || !dni_dorso_url) {
      return new Response(
        JSON.stringify({
          error: "Faltan dni_frente_url y/o dni_dorso_url",
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    // 1. Descargar imagenes en paralelo y convertir a base64.
    //    En simultaneo peritamos los archivos originales (si el cliente los subio).
    const [frente, dorso, forFrente, forDorso] = await Promise.all([
      fetchImageAsBase64(dni_frente_url),
      fetchImageAsBase64(dni_dorso_url),
      forenseDeUrl(dni_frente_orig_url),
      forenseDeUrl(dni_dorso_orig_url),
    ]);

    // 2. Llamar a Claude API con vision
    const claudePayload = {
      model: "claude-opus-4-7",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: frente.mediaType,
                data: frente.data,
              },
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: dorso.mediaType,
                data: dorso.data,
              },
            },
            {
              type: "text",
              text: buildUserPrompt(datero || {}),
            },
          ],
        },
      ],
    };

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(claudePayload),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      return new Response(
        JSON.stringify({
          error: "Claude API fallo",
          status: claudeResp.status,
          detail: errText,
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    const claudeData = await claudeResp.json();
    const rawText = claudeData?.content?.[0]?.text ?? "";

    // Parsear JSON de la respuesta (tolerante a markdown accidental)
    let parsed: any;
    try {
      const cleaned = rawText
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      return new Response(
        JSON.stringify({
          error: "No pude parsear respuesta de Claude",
          raw: rawText,
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        }
      );
    }

    // 3. Chequeo de DNI vencido (fechas calculadas en el server, no confiamos en que Claude sepa hoy)
    const ext = parsed.extraido || {};
    const cal = parsed.calidad || {};
    function parseFechaArg(s: unknown): Date | null {
      if (!s) return null;
      const str = String(s).trim();
      // DD/MM/AAAA o DD-MM-AAAA
      const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(str);
      if (m) {
        const d = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10) - 1;
        let y = parseInt(m[3], 10);
        if (y < 100) y = y < 50 ? 2000 + y : 1900 + y;
        const dt = new Date(Date.UTC(y, mo, d));
        return isNaN(dt.getTime()) ? null : dt;
      }
      // YYYY-MM-DD
      const m2 = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
      if (m2) {
        const dt = new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3]));
        return isNaN(dt.getTime()) ? null : dt;
      }
      return null;
    }
    const vencDate = parseFechaArg(ext.fecha_vencimiento);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let vencido = false;
    let venceProntoDias: number | null = null;
    if (vencDate) {
      const diffDays = Math.floor((vencDate.getTime() - today.getTime()) / 86400000);
      vencido = diffDays < 0;
      if (!vencido && diffDays <= 30) venceProntoDias = diffDays;
    }
    // Agregamos el flag al frente (la fecha de vencimiento esta del lado del frente en DNIs argentinos)
    if (cal.frente && typeof cal.frente === 'object') {
      cal.frente.vencido = vencido;
      if (vencido) {
        cal.frente.ok = false;
        cal.frente.motivo = (cal.frente.motivo ? cal.frente.motivo + ' · ' : '') +
          'DNI VENCIDO (venció el ' + String(ext.fecha_vencimiento) + '). Un DNI vencido no se puede usar.';
      }
    }
    if (vencido) cal.ok_global = false;
    parsed.calidad = cal;

    // 3.b PERITAJE DE AUTENTICIDAD.
    //     Cruza el frente contra la MRZ del dorso, valida el CUIL y perita el
    //     archivo. Es lo que detecta un DNI regenerado con IA: el generador
    //     reescribe las fechas del frente pero copia la MRZ del dorso tal cual,
    //     y esa contradiccion no se puede disimular.
    const autenticidad = peritar({
      extraido: ext,
      mrzLineas: parsed.mrz || null,
      visual: parsed.autenticidad_visual || null,
      forenseFrente: forFrente,
      forenseDorso: forDorso,
      origenPDF: !!origen_pdf,
    });

    if (autenticidad.nivel === "rojo") {
      const motivosRojos = autenticidad.motivos
        .filter((m) => m.nivel === "rojo")
        .map((m) => m.titulo)
        .join(" · ");
      cal.ok_global = false;
      for (const cara of ["frente", "dorso"] as const) {
        if (cal[cara] && typeof cal[cara] === "object") {
          cal[cara].ok = false;
          cal[cara].adulterado = true;
          cal[cara].motivo = (cal[cara].motivo ? cal[cara].motivo + " · " : "") +
            "DOCUMENTO ADULTERADO: " + motivosRojos;
        }
      }
      parsed.calidad = cal;
    }

    // Queda constancia de TODOS los peritajes, no solo de los rojos: sirve para
    // mostrarle a VW que el control existe y corre siempre.
    await registrarPeritaje({
      origen: String(body.origen || "f01"),
      referencia: body.referencia ? String(body.referencia) : null,
      dni: ext.dni ?? null,
      apellido: ext.apellido ?? null,
      nombre: ext.nombre ?? null,
      nivel: autenticidad.nivel,
      motivos: autenticidad.motivos,
      mrz: autenticidad.mrz,
      forense: autenticidad.forense,
      extraido: ext,
      sha256_frente: forFrente?.sha256 ?? null,
      sha256_dorso: forDorso?.sha256 ?? null,
      url_frente: dni_frente_url,
      url_dorso: dni_dorso_url,
      usuario: body.usuario ? String(body.usuario) : null,
      origen_pdf: !!origen_pdf,
    });

    if (autenticidad.nivel === "rojo") await dispararAviso();

    // 4. Modo:
    //    - Si viene datero con algun valor: hace matching contra el datero.
    //    - Si no viene datero (o todo vacio): solo devuelve calidad + extraido.
    //      Este es el modo "paso 1 del cliente" (auto-fill).
    const d = datero || {};
    const dateroHasData = Object.values(d).some(
      (v) => v != null && String(v).trim() !== ""
    );

    const resultado: Record<string, unknown> = {
      calidad: parsed.calidad || null,
      extraido: ext,
      vencido,
      vence_pronto_dias: venceProntoDias,
      autenticidad,
      // atajos para que el frontend no tenga que navegar el objeto
      adulterado: autenticidad.nivel === "rojo",
      nivel_autenticidad: autenticidad.nivel,
      modelo: claudePayload.model,
      analizado_at: new Date().toISOString(),
    };

    if (dateroHasData) {
      const matches: Array<{
        campo: string;
        ok: boolean;
        similitud: number;
        valor_cliente: string;
        valor_dni: string;
        sugerido_ok: boolean;
      }> = [];

      const pushMatch = (
        campo: string,
        cliente: string,
        dni: string,
        minOk = 0.95,
        minSugerido = 0.8
      ) => {
        const s = similitud(normTxt(cliente), normTxt(dni));
        matches.push({
          campo,
          ok: s >= minOk,
          sugerido_ok: s >= minSugerido,
          similitud: Number(s.toFixed(3)),
          valor_cliente: cliente || "",
          valor_dni: dni || "",
        });
      };

      const dniCliente = normDni(d.dni || "");
      const dniDni = normDni(ext.dni || "");
      matches.push({
        campo: "dni",
        ok: !!dniCliente && dniCliente === dniDni,
        sugerido_ok: !!dniCliente && dniCliente === dniDni,
        similitud: dniCliente && dniCliente === dniDni ? 1 : 0,
        valor_cliente: d.dni || "",
        valor_dni: ext.dni || "",
      });

      pushMatch("nombre", d.nombre || "", ext.nombre || "", 0.9, 0.75);
      pushMatch("apellido", d.apellido || "", ext.apellido || "", 0.9, 0.75);
      pushMatch("localidad", d.localidad || "", ext.localidad || "", 0.85, 0.7);
      pushMatch("provincia", d.provincia || "", ext.provincia || "", 0.85, 0.7);
      pushMatch("direccion", d.direccion || "", ext.domicilio || "", 0.8, 0.6);

      resultado.matches = matches;
      resultado.mismatches = matches.filter((m) => !m.ok);
      resultado.mismatches_duros = matches.filter((m) => !m.sugerido_ok);
    }

    return new Response(JSON.stringify(resultado), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err?.message || err) }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
});
