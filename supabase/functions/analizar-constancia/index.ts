// Supabase Edge Function: analizar-constancia
// Lee una constancia de ARCA (ex AFIP) con vision/PDF y determina si el
// contribuyente es MONOTRIBUTO o RESPONSABLE INSCRIPTO, para confirmar lo que
// el cliente declaro en el formulario VWFS (condicion fiscal del Independiente).
//
// Distingue:
//   - "CONSTANCIA DE OPCION - Regimen Simplificado para Pequenos Contribuyentes"
//     => MONOTRIBUTO (tiene la palabra MONOTRIBUTO + una CATEGORIA, letra A..K).
//   - "CONSTANCIA DE INSCRIPCION" con IVA entre los impuestos => RESP. INSCRIPTO.
//
// El servidor calcula si la constancia esta "actualizada al mes corriente"
// (no confiamos en que el modelo sepa la fecha de hoy).
//
// Input:  { constancia_url: string, declarado?: "Monotributista" | "Responsable Inscripto" }
// Output: JSON con { condicion, categoria, cuit, nombre, vigencia_*, mes_corriente, coincide, veredicto, mensaje, ... }
//
// Deploy: supabase functions deploy analizar-constancia --project-ref wjfglsafgaltusmbnccl
//         (necesita el secret ANTHROPIC_API_KEY, ya configurado en el proyecto)

// deno-lint-ignore-file no-explicit-any

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODELO = "claude-opus-4-7";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function bajarComoBase64(url: string): Promise<{
  data: string;
  mediaType: string;
  esPDF: boolean;
}> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`No pude descargar ${url}: ${resp.status}`);
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Deteccion de PDF por content-type o por firma %PDF.
  const firma = String.fromCharCode(...bytes.subarray(0, 5));
  const esPDF = ct.includes("pdf") || firma === "%PDF-";
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  const data = btoa(binary);
  let mediaType = ct;
  if (esPDF) mediaType = "application/pdf";
  else if (!mediaType.startsWith("image/")) mediaType = "image/jpeg";
  return { data, mediaType, esPDF };
}

const SYSTEM_PROMPT =
  `Sos un asistente que lee constancias de ARCA (ex AFIP) de Argentina y extrae datos.
Devolves SIEMPRE un unico objeto JSON valido, sin texto antes ni despues, sin markdown.
No inventes: si un dato no se lee con certeza, poner null. No evalues si las fechas son
viejas o actuales: NO sabes la fecha de hoy, solo transcribi las fechas tal cual estan.`;

const USER_PROMPT =
  `Te paso una constancia de ARCA. Determina que tipo de contribuyente es y los datos.

Hay dos tipos principales:
- "CONSTANCIA DE OPCION - Regimen Simplificado para Pequenos Contribuyentes": es MONOTRIBUTO.
  Tiene la palabra MONOTRIBUTO y una CATEGORIA (una sola letra, de la A a la K).
- "CONSTANCIA DE INSCRIPCION": mira los impuestos nacionales registrados. Si figura IVA, es
  RESPONSABLE INSCRIPTO (suele tener tambien GANANCIAS PERSONAS FISICAS y REG. TRAB. AUTONOMO).

Devolveme EXACTAMENTE este JSON:
{
  "tipo_documento": "constancia_opcion" | "constancia_inscripcion" | "otro",
  "condicion": "Monotributo" | "Responsable Inscripto" | "Exento" | "Otro",
  "cuit": string | null,                 // formato XX-XXXXXXXX-X
  "nombre": string | null,               // nombre y apellido o razon social del titular
  "categoria_monotributo": string | null,// la letra (A..K) si es monotributo; null si no
  "tiene_iva": boolean,                  // true si IVA figura entre los impuestos nacionales
  "tiene_monotributo": boolean,          // true si dice MONOTRIBUTO / Regimen Simplificado
  "vigencia_desde": string | null,       // DD-MM-AAAA, de "Vigencia de la presente constancia: X a Y"
  "vigencia_hasta": string | null,       // DD-MM-AAAA
  "legible": boolean,                    // false si no se puede leer el documento
  "senales": string[]                    // que te hizo decidir (ej: "figura IVA", "dice MONOTRIBUTO categoria D")
}

Reglas de decision:
- Si figura IVA entre los impuestos -> condicion "Responsable Inscripto", tipo "constancia_inscripcion".
- Si es "Constancia de Opcion" / dice MONOTRIBUTO -> condicion "Monotributo", tipo "constancia_opcion".
- Si no es ninguna de las dos (otra constancia, otro documento, ilegible) -> "otro"/"Otro" y legible segun corresponda.`;

// Normaliza la condicion declarada o detectada a una clave comparable.
function normCond(s: unknown): string {
  const t = String(s || "").toLowerCase();
  if (t.includes("monotrib")) return "monotributo";
  if (t.includes("responsable") || t.includes("resp. insc") || t.includes("inscripto")) {
    return "responsable_inscripto";
  }
  return "";
}

// Parsea DD-MM-AAAA o DD/MM/AAAA a Date (hora 0 local).
function parseFecha(s: unknown): Date | null {
  if (!s) return null;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const d = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return isNaN(d.getTime()) ? null : d;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY no configurada" }, 500);

    const body = await req.json().catch(() => ({}));
    const constanciaUrl: string = body?.constancia_url || body?.url || "";
    const declarado: string = body?.declarado || "";
    if (!constanciaUrl) return json({ error: "Falta constancia_url" }, 400);

    const archivo = await bajarComoBase64(constanciaUrl);

    const bloqueDoc = archivo.esPDF
      ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: archivo.data },
      }
      : {
        type: "image",
        source: { type: "base64", media_type: archivo.mediaType, data: archivo.data },
      };

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [bloqueDoc, { type: "text", text: USER_PROMPT }],
        }],
      }),
    });

    if (!claudeResp.ok) {
      const detail = await claudeResp.text();
      return json({ error: "Claude API fallo", status: claudeResp.status, detail }, 502);
    }

    const claudeData = await claudeResp.json();
    const rawText = claudeData?.content?.[0]?.text ?? "";
    let ext: any;
    try {
      const cleaned = rawText.trim()
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "").trim();
      ext = JSON.parse(cleaned);
    } catch (_e) {
      return json({ error: "No pude parsear la respuesta de Claude", raw: rawText }, 502);
    }

    // --- Calculos en el servidor (no confiamos en que el modelo sepa hoy) ----
    const detectadaKey = normCond(ext.condicion);
    const declaradaKey = normCond(declarado);
    const esMonoORI = detectadaKey === "monotributo" || detectadaKey === "responsable_inscripto";

    const hoy = new Date();
    const desde = parseFecha(ext.vigencia_desde);
    const hasta = parseFecha(ext.vigencia_hasta);
    // "Actualizada al mes corriente": emitida (vigencia_desde) en el mes/anio actual.
    const mesCorriente = !!desde &&
      desde.getMonth() === hoy.getMonth() &&
      desde.getFullYear() === hoy.getFullYear();
    // Vencida: hoy pasó la vigencia_hasta.
    const vencida = !!hasta && hoy.getTime() > hasta.getTime() + 24 * 3600 * 1000;

    const coincide = declaradaKey ? detectadaKey === declaradaKey : true;

    // Veredicto. ok=true solo si: es Mono/RI, coincide con lo declarado y es del mes corriente.
    let veredicto = "ok";
    let mensaje = "";
    if (ext.legible === false) {
      veredicto = "ilegible";
      mensaje = "No se pudo leer la constancia. Subí una foto nítida o el PDF.";
    } else if (!esMonoORI) {
      veredicto = "no_corresponde";
      mensaje =
        "La constancia no es ni de Monotributo ni de Responsable Inscripto. Subí la constancia correcta.";
    } else if (!coincide) {
      veredicto = "no_coincide";
      const nombreDet = detectadaKey === "monotributo" ? "Monotributo" : "Responsable Inscripto";
      const nombreDec = declaradaKey === "monotributo" ? "Monotributo" : "Responsable Inscripto";
      mensaje =
        `La constancia dice ${nombreDet}, pero declaraste ${nombreDec}. Corregí la condición fiscal para que coincida.`;
    } else if (!mesCorriente) {
      veredicto = "vieja";
      mensaje = desde
        ? `La constancia es del ${ext.vigencia_desde}, no del mes corriente. Pedí una constancia actualizada de este mes.`
        : "No pude leer la fecha de la constancia. Subí una constancia actualizada de este mes.";
    } else {
      veredicto = "ok";
      const cat = ext.categoria_monotributo ? ` (categoría ${ext.categoria_monotributo})` : "";
      mensaje = `Confirmado: ${detectadaKey === "monotributo" ? "Monotributo" + cat : "Responsable Inscripto"}.`;
    }

    return json({
      ok: veredicto === "ok",
      veredicto,
      mensaje,
      condicion_detectada: esMonoORI
        ? (detectadaKey === "monotributo" ? "Monotributo" : "Responsable Inscripto")
        : (ext.condicion || "Otro"),
      declarado: declarado || null,
      coincide,
      mes_corriente: mesCorriente,
      vencida,
      categoria_monotributo: ext.categoria_monotributo || null,
      cuit: ext.cuit || null,
      nombre: ext.nombre || null,
      vigencia_desde: ext.vigencia_desde || null,
      vigencia_hasta: ext.vigencia_hasta || null,
      tipo_documento: ext.tipo_documento || null,
      tiene_iva: !!ext.tiene_iva,
      tiene_monotributo: !!ext.tiene_monotributo,
      senales: Array.isArray(ext.senales) ? ext.senales : [],
      analizado_at: new Date().toISOString(),
      modelo: MODELO,
    });
  } catch (e) {
    return json({ error: "Error inesperado", detail: String((e as Error)?.message || e) }, 500);
  }
});
