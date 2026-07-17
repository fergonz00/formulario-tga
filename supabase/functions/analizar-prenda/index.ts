// Edge Function: analizar-prenda
// Revisor de Prendas de Volkswagen Financial Services. Recibe una o varias
// URLs de documento (PDF escaneado y/o fotos de la prenda) y le pide a Claude
// que verifique 6 condiciones. Devuelve un veredicto estructurado (aprobado /
// rechazado + detalle por regla). NO guarda nada — es solo una revisión.
//
// La ANTHROPIC_API_KEY se lee del entorno de Supabase (secret), nunca del cliente.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Método no permitido" }, 405);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY no configurada en Supabase" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  // archivos: [{ url: string, tipo: "pdf" | "imagen", media_type?: string }]
  const archivos = Array.isArray(body?.archivos) ? body.archivos : [];
  if (archivos.length === 0) {
    return json({ error: "No se recibió ningún documento para revisar." }, 400);
  }

  // Construimos el contenido: cada PDF como bloque document, cada imagen como image.
  const content: any[] = [];
  for (const a of archivos) {
    const url = a && typeof a.url === "string" ? a.url : "";
    if (!url.startsWith("http")) continue;
    const tipo = (a.tipo || "").toLowerCase();
    const esPdf = tipo === "pdf" || url.toLowerCase().split("?")[0].endsWith(".pdf");
    if (esPdf) {
      content.push({ type: "document", source: { type: "url", url } });
    } else {
      content.push({ type: "image", source: { type: "url", url } });
    }
  }
  if (content.length === 0) {
    return json({ error: "Ningún documento válido (se esperaban URLs http)." }, 400);
  }

  content.push({ type: "text", text: PROMPT });

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e) {
    return json({ error: "No se pudo contactar la API de Anthropic", detail: String(e) }, 502);
  }

  if (!response.ok) {
    const errText = await response.text();
    return json({ error: "Anthropic API error", status: response.status, detail: errText }, 502);
  }

  const data = await response.json();
  // Con thinking adaptativo, el primer bloque puede ser de tipo "thinking";
  // tomamos el primer bloque de texto real.
  const rawText =
    (Array.isArray(data?.content)
      ? data.content.find((b: any) => b && b.type === "text")?.text
      : "") || "";

  let veredicto: any;
  try {
    const cleaned = rawText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    veredicto = JSON.parse(cleaned);
  } catch {
    return json({ error: "No se pudo parsear el veredicto de Claude", raw: rawText }, 500);
  }

  return json({ veredicto });
});

const PROMPT = `Sos un analista experto en contratos de prenda con registro de Volkswagen Financial Services Compañía Financiera S.A. (Argentina). Te paso el/los documento(s) de UNA prenda escaneada (puede venir en varias hojas: la "Solicitud de Inscripción Contrato Prendario" formulario 03, el "Contrato de Prenda con Registro" del Ministerio de Justicia, y la "Continuación del Contrato de Prenda" con las cláusulas). Tu tarea es REVISAR si la prenda está bien confeccionada según reglas estrictas y decir si se APRUEBA o se RECHAZA.

## Cómo es una prenda BIEN hecha (referencia)
- El ACREEDOR siempre es Volkswagen Financial Services Compañía Financiera S.A., Inscripción N° 9095 L°117 T°A, CUIT 30-68241957-8.
- El DEUDOR (o los deudores) está identificado con apellido y nombre, tipo y número de documento (DNI), fecha de nacimiento, estado civil, nacionalidad y domicilio.
- Los datos del automotor (dominio/patente, marca, tipo, modelo, motor, chasis) y los montos/cuotas están completos.
- El documento está firmado por el acreedor y por el/los deudor(es).

## LAS 6 CONDICIONES A VERIFICAR (todas deben cumplirse para APROBAR)

1. **Nombre y apellido bien escrito**: el nombre y apellido del/los deudor(es) tiene que estar escrito correctamente (sin errores evidentes de ortografía/tipeo) y escrito igual en todas las hojas donde aparece. Si en una hoja dice un apellido y en otra otro, o está claramente mal escrito, es una falla.

2. **DNI idéntico en todos lados**: el número de DNI del deudor debe ser EXACTAMENTE EL MISMO en todos los lugares donde aparece (en el formulario 03, en el Contrato con Registro, en la Continuación, en el CUIL, etc.). Si encontrás un número de DNI distinto en algún lugar, es RECHAZO. (Ignorá la separación con puntos: 31.913.986 y 31913986 son el mismo número.)

3. **Firmas según estado civil** (regla clave, contá las firmas con cuidado):
   - Si el estado civil del deudor es **SOLTERO/A** (u otro estado que no requiera cónyuge): debe firmar **1 sola persona**. En cada lugar de "Firma del Deudor" tiene que haber 1 firma.
   - Si el estado civil es **CASADO/A** (o convive registrado): SIEMPRE deben firmar **2 personas** (deudor + cónyuge/conviviente). En cada lugar donde en una prenda de soltero iría 1 firma, en la de casado tienen que ir 2 firmas, una al lado de la otra. Además debe estar completado el asentimiento conyugal (cláusula del art. 470 del Código Civil y Comercial).
   - **Si dice CASADO y ves una sola firma donde deberían ir dos → RECHAZO.**
   - Contá las firmas en los lugares de firma del deudor y compará con el estado civil declarado.

4. **Domicilio**: el domicilio del deudor tiene que estar completo (calle, número, localidad/partido, provincia) y ser coherente entre las hojas donde aparece.

5. **Sin campos básicos vacíos**: los campos esenciales del contrato no pueden estar en blanco (deudor: nombre, DNI, domicilio, estado civil; automotor: dominio/patente, marca, modelo; monto del contrato; y las firmas). Si falta alguno de estos datos básicos, es una falla.

6. **Original, no copia**: el documento tiene que ser un ORIGINAL. Si en CUALQUIER parte del documento aparece la palabra "COPIA" (por ejemplo "copia del original", "copia fiel", "duplicado", "es copia", o cualquier leyenda que indique que es una copia) → RECHAZO. Una prenda original no debe tener ninguna leyenda de copia.

## Cómo decidir
- Si TODAS las 6 condiciones se cumplen → aprobado = true.
- Si CUALQUIERA falla → aprobado = false, y explicá el/los motivo(s) concreto(s).
- Ante una duda razonable sobre una firma o un dato, marcá la condición como no cumplida y explicá qué revisar (mejor pecar de cuidadoso: es una aprobación con consecuencias legales).

## Formato de respuesta (OBLIGATORIO)
Devolvé EXCLUSIVAMENTE un objeto JSON (sin texto adicional, sin markdown, sin bloques de código) con esta estructura EXACTA:

{
  "aprobado": true,
  "deudor_nombre": "Apellido y nombre del deudor principal tal como figura en el documento",
  "deudor_dni": "número de DNI del deudor principal, solo dígitos",
  "estado_civil_detectado": "soltero",
  "firmas": { "esperadas": 1, "encontradas": 1 },
  "checks": [
    { "regla": "Nombre y apellido bien escrito", "ok": true, "detalle": "Texto corto en español rioplatense explicando qué viste." },
    { "regla": "DNI idéntico en todos lados", "ok": true, "detalle": "..." },
    { "regla": "Firmas según estado civil", "ok": true, "detalle": "..." },
    { "regla": "Domicilio completo y coherente", "ok": true, "detalle": "..." },
    { "regla": "Sin campos básicos vacíos", "ok": true, "detalle": "..." },
    { "regla": "Original (no copia)", "ok": true, "detalle": "..." }
  ],
  "motivos_rechazo": [],
  "resumen": "Una o dos oraciones con la conclusión general."
}

Reglas del JSON:
- "deudor_nombre": apellido y nombre del deudor principal (si hay 2 titulares, el primero/principal). Si no lo podés leer, poné "".
- "deudor_dni": el número de DNI del deudor principal, solo dígitos (sin puntos). Si no lo podés leer, poné "".
- "aprobado" es true SOLO si los 6 "ok" son true.
- "estado_civil_detectado" debe ser exactamente "soltero", "casado" o "no_detectado".
- "firmas.esperadas" es 1 para soltero, 2 para casado; "firmas.encontradas" es cuántas contaste en los lugares de firma del deudor.
- "checks" debe tener SIEMPRE las 6 reglas, en ese orden, con sus nombres exactos.
- "motivos_rechazo" es una lista de strings con los motivos concretos si aprobado=false; lista vacía [] si aprobado=true.
- Todo el texto visible en español rioplatense, claro y breve.
- Devolvé SOLO el JSON, nada más.`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
