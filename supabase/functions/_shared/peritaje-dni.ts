// Peritaje de autenticidad de DNI argentino (formato tarjeta, RENAPER 2012+).
//
// Motivo: en agosto/2026 VW detecto DNIs que habian sido "mejorados" con IA
// generativa. El generador reescribio fechas y numero de tramite del FRENTE
// pero copio la MRZ del DORSO tal cual. Eso deja una contradiccion interna
// que se detecta con matematica pura, sin depender del criterio del modelo.
//
// Este modulo NO llama a ninguna API. Son chequeos deterministicos + un
// scoring que combina lo deterministico con las senales visuales que reporta
// el modelo de vision.
//
// Verificado contra dos DNIs reales (GIMENEZ 22.154.969 / GUZMAN 29.647.626):
// todos los digitos verificadores de la MRZ y ambos CUIL cierran.

// deno-lint-ignore-file no-explicit-any

export type NivelAutenticidad = "verde" | "amarillo" | "rojo";

export type MotivoPeritaje = {
  codigo: string;
  nivel: "rojo" | "amarillo";
  titulo: string;
  detalle: string;
};

// ---------------------------------------------------------------------------
// MRZ (Machine Readable Zone) - formato TD1, 3 lineas de 30 caracteres.
// ---------------------------------------------------------------------------

/** Digito verificador ICAO 9303 (pesos 7-3-1). */
export function dvICAO(s: string): number {
  const pesos = [7, 3, 1];
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let v: number;
    if (c === "<") v = 0;
    else if (c >= "0" && c <= "9") v = c.charCodeAt(0) - 48;
    else if (c >= "A" && c <= "Z") v = c.charCodeAt(0) - 55;
    else v = 0;
    total += v * pesos[i % 3];
  }
  return total % 10;
}

export type MRZ = {
  crudo: { linea1: string; linea2: string; linea3: string };
  tipoDoc: string;
  pais: string;
  nroDocumento: string; // solo digitos
  fechaNacimiento: string; // DD/MM/AAAA
  fechaVencimiento: string; // DD/MM/AAAA
  sexo: string; // M | F | X
  nacionalidad: string;
  apellido: string;
  nombres: string;
  checks: {
    documento: boolean;
    fechaNacimiento: boolean;
    fechaVencimiento: boolean;
    compuesto: boolean;
    todosOk: boolean;
  };
};

function limpiarLineaMRZ(s: string): string {
  return (s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    // el modelo a veces transcribe los chevrones como comillas angulares
    .replace(/[«‹❮〈〈]/g, "<")
    .replace(/[^A-Z0-9<]/g, "");
}

/** AA de 2 digitos -> anio de 4. `futuro` = true para fechas de vencimiento. */
function anio4(aa: number, futuro: boolean, hoy: Date): number {
  if (futuro) return 2000 + aa;
  const yy = hoy.getUTCFullYear() % 100;
  return aa > yy ? 1900 + aa : 2000 + aa;
}

function fechaMRZ(s: string, futuro: boolean, hoy: Date): string {
  if (!/^\d{6}$/.test(s)) return "";
  const aa = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
  const yyyy = anio4(aa, futuro, hoy);
  return `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yyyy}`;
}

/**
 * Parsea las 3 lineas de la MRZ del dorso.
 * Devuelve null si las lineas no tienen la forma esperada (no asumimos nada).
 */
export function parseMRZ(
  l1raw: string,
  l2raw: string,
  l3raw: string,
  hoy: Date = new Date(),
): MRZ | null {
  const l1 = limpiarLineaMRZ(l1raw);
  const l2 = limpiarLineaMRZ(l2raw);
  const l3 = limpiarLineaMRZ(l3raw);

  // TD1 son 30 chars por linea.
  //
  // OJO: el modelo de vision se come o agrega chevrones al transcribir la cola
  // de relleno (es facil contar mal 15 "<" seguidos). Si rellenamos a ciegas
  // con padEnd, el digito verificador compuesto -que va en la ULTIMA posicion
  // de la linea 2- se corre de lugar y da falso positivo de adulteracion.
  // Por eso reconstruimos cada linea desde los campos de posicion fija y
  // normalizamos SOLO la zona de relleno.
  if (l1.length < 15 || l2.length < 19) return null;
  if (!/^[IAC]/.test(l1)) return null;

  // Linea 1: pos 0-14 fijas (tipo + pais + documento + dv), 15-29 opcional.
  const rellenoL1 = l1.slice(15).padEnd(15, "<").slice(0, 15);
  const p1 = l1.slice(0, 15) + rellenoL1;

  // Linea 2: pos 0-17 fijas (fnac+dv, sexo, venc+dv, nacionalidad),
  // 18-28 opcional, 29 = digito verificador compuesto (siempre el ultimo).
  const dvCompLeido = l2.slice(-1);
  const rellenoL2 = l2.slice(18, l2.length - 1).padEnd(11, "<").slice(0, 11);
  const p2 = l2.slice(0, 18) + rellenoL2 + dvCompLeido;

  const tipoDoc = p1.slice(0, 2).replace(/</g, "");
  const pais = p1.slice(2, 5).replace(/</g, "");
  const campoDoc = p1.slice(5, 14); // 9 chars
  const dvDoc = p1.slice(14, 15);
  const nroDocumento = campoDoc.replace(/</g, "").replace(/\D/g, "");

  const fNacRaw = p2.slice(0, 6);
  const dvNac = p2.slice(6, 7);
  const sexo = p2.slice(7, 8);
  const fVencRaw = p2.slice(8, 14);
  const dvVenc = p2.slice(14, 15);
  const nacionalidad = p2.slice(15, 18).replace(/</g, "");
  const dvComp = p2.slice(29, 30);

  const compuesto = p1.slice(5, 30) + p2.slice(0, 7) + p2.slice(8, 15) +
    p2.slice(18, 29);

  const partes = l3.split("<<");
  const apellido = (partes[0] || "").replace(/</g, " ").trim();
  const nombres = (partes[1] || "").replace(/</g, " ").trim();

  const checks = {
    documento: /^\d$/.test(dvDoc) && dvICAO(campoDoc) === Number(dvDoc),
    fechaNacimiento: /^\d$/.test(dvNac) && dvICAO(fNacRaw) === Number(dvNac),
    fechaVencimiento: /^\d$/.test(dvVenc) && dvICAO(fVencRaw) === Number(dvVenc),
    compuesto: /^\d$/.test(dvComp) && dvICAO(compuesto) === Number(dvComp),
    todosOk: false,
  };
  checks.todosOk = checks.documento && checks.fechaNacimiento &&
    checks.fechaVencimiento && checks.compuesto;

  return {
    crudo: { linea1: l1, linea2: l2, linea3: l3 },
    tipoDoc,
    pais,
    nroDocumento,
    fechaNacimiento: fechaMRZ(fNacRaw, false, hoy),
    fechaVencimiento: fechaMRZ(fVencRaw, true, hoy),
    sexo: sexo === "<" ? "X" : sexo,
    nacionalidad,
    apellido,
    nombres,
    checks,
  };
}

// ---------------------------------------------------------------------------
// CUIL / CUIT - modulo 11.
// ---------------------------------------------------------------------------

export function dvCUIL(prefijo: number, dni: string): number | null {
  const d = (dni || "").replace(/\D/g, "");
  if (!d || d.length > 8) return null;
  const base = String(prefijo).padStart(2, "0") + d.padStart(8, "0");
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let total = 0;
  for (let i = 0; i < 10; i++) total += Number(base[i]) * pesos[i];
  const r = 11 - (total % 11);
  if (r === 11) return 0;
  if (r === 10) return 9;
  return r;
}

export type ChequeoCUIL = {
  formatoOk: boolean;
  dvOk: boolean;
  coincideDni: boolean;
  prefijoCoherenteConSexo: boolean;
  prefijo: number | null;
  dniDelCuil: string | null;
};

export function verificarCUIL(
  cuil: string,
  dniFrente: string,
  sexo: string,
): ChequeoCUIL | null {
  const s = (cuil || "").replace(/\D/g, "");
  if (s.length !== 11) return null;
  const prefijo = Number(s.slice(0, 2));
  const dniDelCuil = s.slice(2, 10).replace(/^0+/, "");
  const dvDado = Number(s.slice(10, 11));
  const dvCalc = dvCUIL(prefijo, dniDelCuil);
  const dniF = (dniFrente || "").replace(/\D/g, "").replace(/^0+/, "");
  const sx = (sexo || "").toUpperCase();
  // 20/24 masculino, 27 femenino. El 23 se usa para ambos.
  const prefijoCoherenteConSexo = prefijo === 23 ||
    (sx === "M" && (prefijo === 20 || prefijo === 24)) ||
    (sx === "F" && prefijo === 27) ||
    sx === "" || sx === "X";
  return {
    formatoOk: [20, 23, 24, 27, 30, 33, 34].includes(prefijo),
    dvOk: dvCalc !== null && dvCalc === dvDado,
    coincideDni: !!dniF && dniF === dniDelCuil,
    prefijoCoherenteConSexo,
    prefijo,
    dniDelCuil,
  };
}

// ---------------------------------------------------------------------------
// Forense del archivo.
// ---------------------------------------------------------------------------

export type ForenseArchivo = {
  formato: "jpeg" | "png" | "webp" | "pdf" | "desconocido";
  ancho: number | null;
  alto: number | null;
  bytes: number;
  tieneExif: boolean;
  camara: string | null; // Make/Model del EXIF si esta
  tieneC2PA: boolean; // credencial de contenido (la firman los generadores)
  resolucionEnListaNegra: boolean;
  ambosLadosMultiploDe64: boolean;
  sha256: string | null;
};

/**
 * Resoluciones de salida tipicas de generadores de imagen.
 * Ninguna camara de celular produce estos tamanos exactos.
 */
const RESOLUCIONES_GENERADOR: string[] = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1408x768",
  "768x1408",
  "1792x1024",
  "1024x1792",
  "1344x768",
  "768x1344",
  "1152x896",
  "896x1152",
  "1216x832",
  "832x1216",
  "1248x832",
  "832x1248",
  "1280x896",
  "896x1280",
  "2048x2048",
  "1152x768",
  "768x1152",
];

function dimsJPEG(b: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15 salvo DHT(C4), JPG(C8), DAC(CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    if (len <= 0) break;
    i += 2 + len;
  }
  return null;
}

/** Parseo TIFF minimo para sacar Make (0x010F) y Model (0x0110). */
function leerMakeModel(b: Uint8Array, tiffStart: number): string | null {
  try {
    const le = b[tiffStart] === 0x49;
    const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o: number) =>
      le
        ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
        : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const ifd0 = tiffStart + u32(tiffStart + 4);
    const n = u16(ifd0);
    const partes: string[] = [];
    for (let k = 0; k < n && k < 200; k++) {
      const e = ifd0 + 2 + k * 12;
      const tag = u16(e);
      if (tag !== 0x010f && tag !== 0x0110) continue;
      const count = u32(e + 4);
      const off = count <= 4 ? e + 8 : tiffStart + u32(e + 8);
      let s = "";
      for (let j = 0; j < count - 1 && off + j < b.length; j++) {
        s += String.fromCharCode(b[off + j]);
      }
      s = s.trim();
      if (s) partes.push(s);
    }
    return partes.length ? partes.join(" ") : null;
  } catch {
    return null;
  }
}

function leerExifJPEG(b: Uint8Array): { presente: boolean; camara: string | null } {
  let i = 2;
  while (i < b.length - 4) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1) {
      const tag = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (tag === "Exif") {
        return { presente: true, camara: leerMakeModel(b, i + 10) };
      }
    }
    if (len <= 0) break;
    i += 2 + len;
  }
  return { presente: false, camara: null };
}

function dimsPNG(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  const u32 = (o: number) =>
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { w: u32(16), h: u32(20) };
}

function contiene(b: Uint8Array, txt: string, hasta = 200000): boolean {
  const needle = new TextEncoder().encode(txt);
  const lim = Math.min(b.length - needle.length, hasta);
  outer: for (let i = 0; i < lim; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (b[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export async function forenseArchivo(
  bytes: Uint8Array,
  mime: string,
): Promise<ForenseArchivo> {
  let formato: ForenseArchivo["formato"] = "desconocido";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) formato = "jpeg";
  else if (bytes[0] === 0x89 && bytes[1] === 0x50) formato = "png";
  else if (bytes[0] === 0x25 && bytes[1] === 0x50) formato = "pdf";
  else if (contiene(bytes.subarray(0, 32), "WEBP")) formato = "webp";
  else if ((mime || "").includes("pdf")) formato = "pdf";

  let dims: { w: number; h: number } | null = null;
  let exif = { presente: false, camara: null as string | null };
  if (formato === "jpeg") {
    dims = dimsJPEG(bytes);
    exif = leerExifJPEG(bytes);
  } else if (formato === "png") {
    dims = dimsPNG(bytes);
  }

  // C2PA / Content Credentials: los generadores firman la imagen.
  const tieneC2PA = contiene(bytes, "c2pa", 400000) ||
    contiene(bytes, "jumbf", 400000);

  let sha256: string | null = null;
  try {
    const copia = bytes.slice();
    const h = await crypto.subtle.digest("SHA-256", copia);
    sha256 = Array.from(new Uint8Array(h))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    /* opcional */
  }

  const clave = dims ? `${dims.w}x${dims.h}` : "";
  return {
    formato,
    ancho: dims?.w ?? null,
    alto: dims?.h ?? null,
    bytes: bytes.length,
    tieneExif: exif.presente,
    camara: exif.camara,
    tieneC2PA,
    resolucionEnListaNegra: !!clave && RESOLUCIONES_GENERADOR.includes(clave),
    ambosLadosMultiploDe64: !!dims && dims.w % 64 === 0 && dims.h % 64 === 0,
    sha256,
  };
}

// ---------------------------------------------------------------------------
// PDF: extraccion de las imagenes embebidas.
// ---------------------------------------------------------------------------

export type ImagenDePDF = {
  bytes: Uint8Array;
  mime: string;
  ancho: number | null;
  alto: number | null;
};

/**
 * Saca las imagenes que estan adentro de un PDF, en su resolucion original.
 *
 * Importante: extraemos el stream tal cual, NO rasterizamos la pagina. Eso
 * conserva el tamano exacto del JPEG embebido, que es la evidencia que delata
 * a un DNI regenerado con IA (1536x1024 y similares). Lo unico que se pierde
 * al pasar por un PDF son el EXIF y la firma C2PA, que el armador del PDF
 * descarta.
 *
 * Soporta imagenes DCTDecode (JPEG). Las que estan comprimidas con Flate
 * quedan afuera porque descomprimirlas y rearmar el bitmap no aporta nada:
 * igual leemos el ancho y alto del diccionario del objeto.
 */
export function extraerImagenesDePDF(pdf: Uint8Array): ImagenDePDF[] {
  const out: ImagenDePDF[] = [];
  // Leemos el PDF como latin1: cada byte es un char, asi podemos usar regex
  // sobre la estructura sin romper los datos binarios.
  let txt = "";
  const chunk = 0x8000;
  for (let i = 0; i < pdf.length; i += chunk) {
    txt += String.fromCharCode(...pdf.subarray(i, Math.min(i + chunk, pdf.length)));
  }

  const re = /\/Subtype\s*\/Image([\s\S]{0,600}?)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const dic = m[1];
    const mLen = /\/Length\s+(\d+)/.exec(dic);
    if (!mLen) continue;
    const len = Number(mLen[1]);
    if (!len || len > 40 * 1024 * 1024) continue;
    const ini = m.index + m[0].length;
    const mW = /\/Width\s+(\d+)/.exec(dic);
    const mH = /\/Height\s+(\d+)/.exec(dic);
    const esJpeg = /\/DCTDecode/.test(dic);
    if (!esJpeg) continue;
    out.push({
      bytes: pdf.subarray(ini, ini + len),
      mime: "image/jpeg",
      ancho: mW ? Number(mW[1]) : null,
      alto: mH ? Number(mH[1]) : null,
    });
  }
  return out;
}

/** true si el archivo arranca con la firma de un PDF. */
export function esPDF(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46;
}

// ---------------------------------------------------------------------------
// Peritaje.
// ---------------------------------------------------------------------------

export type SenalesVisuales = {
  ghost_portrait_correcto?: boolean | null;
  guilloches_coherentes?: boolean | null;
  tipografia_uniforme?: boolean | null;
  barcode_estructura_valida?: boolean | null;
  microimpresion_legible?: boolean | null;
  fondo_recortado_artificial?: boolean | null;
  senales?: string[];
  sospecha_ia?: "no" | "baja" | "media" | "alta";
  motivo_sospecha?: string;
};

export type DatosFrente = {
  dni?: string | null;
  sexo?: string | null;
  fecha_nacimiento?: string | null;
  fecha_emision?: string | null;
  fecha_vencimiento?: string | null;
  apellido?: string | null;
  nombre?: string | null;
  cuil?: string | null;
};

export type EntradaPeritaje = {
  extraido: DatosFrente;
  mrzLineas?: { linea1?: string; linea2?: string; linea3?: string } | null;
  visual?: SenalesVisuales | null;
  forenseFrente?: ForenseArchivo | null;
  forenseDorso?: ForenseArchivo | null;
  /** true si el documento llego dentro de un PDF (pierde EXIF/C2PA). */
  origenPDF?: boolean;
  /**
   * true si del PDF se pudieron sacar las imagenes embebidas y el forense de
   * `forenseFrente`/`forenseDorso` corresponde a ellas. En ese caso el PDF NO
   * queda en amarillo: se perita igual que una foto suelta, solo que sin EXIF.
   */
  pdfImagenesExtraidas?: boolean;
  hoy?: Date;
};

export type ResultadoPeritaje = {
  nivel: NivelAutenticidad;
  apto: boolean; // false cuando es rojo
  resumen: string;
  motivos: MotivoPeritaje[];
  mrz: MRZ | null;
  cuil: ChequeoCUIL | null;
  forense: { frente: ForenseArchivo | null; dorso: ForenseArchivo | null };
  peritado_at: string;
};

function normFecha(s: unknown): string {
  const str = String(s ?? "").trim();
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(str);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y = y < 50 ? 2000 + y : 1900 + y;
    return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${y}`;
  }
  const m2 = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`;
  return "";
}

function normNombre(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function peritar(e: EntradaPeritaje): ResultadoPeritaje {
  const hoy = e.hoy ?? new Date();
  const motivos: MotivoPeritaje[] = [];
  const ext = e.extraido || {};
  const v = e.visual || {};

  const rojo = (codigo: string, titulo: string, detalle: string) =>
    motivos.push({ codigo, nivel: "rojo", titulo, detalle });
  const amarillo = (codigo: string, titulo: string, detalle: string) =>
    motivos.push({ codigo, nivel: "amarillo", titulo, detalle });

  // --- 1. MRZ del dorso vs datos del frente (el chequeo mas fuerte) ---------
  let mrz: MRZ | null = null;
  if (e.mrzLineas?.linea1 && e.mrzLineas?.linea2) {
    mrz = parseMRZ(
      e.mrzLineas.linea1,
      e.mrzLineas.linea2,
      e.mrzLineas.linea3 || "",
      hoy,
    );
  }

  if (!mrz) {
    amarillo(
      "MRZ_ILEGIBLE",
      "No se pudo leer la MRZ del dorso",
      "Sin las 3 lineas del dorso no se puede cruzar el frente contra el dorso. Pedir una foto del dorso mas nitida.",
    );
  } else {
    // Los verificadores de campo son cortos (6 a 9 caracteres) y muy confiables
    // de transcribir: si uno no cierra, el dato fue tocado.
    const fallanCampos = [
      !mrz.checks.documento ? "nro de documento" : "",
      !mrz.checks.fechaNacimiento ? "fecha de nacimiento" : "",
      !mrz.checks.fechaVencimiento ? "fecha de vencimiento" : "",
    ].filter(Boolean).join(", ");
    if (fallanCampos) {
      rojo(
        "MRZ_DV_INVALIDO",
        "Los digitos verificadores de la MRZ no cierran",
        `Fallan: ${fallanCampos}. En un DNI autentico la MRZ siempre cierra.`,
      );
    }
    // El verificador compuesto abarca las 30 posiciones de ambas lineas,
    // incluida la cola de chevrones. Un chevron de mas o de menos en la
    // transcripcion lo tumba sin que el documento tenga nada malo, asi que
    // solo lo marcamos para revisar.
    if (!mrz.checks.compuesto) {
      amarillo(
        "MRZ_DV_COMPUESTO",
        "El verificador general de la MRZ no cierra",
        "Puede ser un error al transcribir la fila de chevrones. Si los demas verificadores cierran y los datos coinciden, no hay evidencia de adulteracion.",
      );
    }

    const dniFrente = String(ext.dni ?? "").replace(/\D/g, "").replace(/^0+/, "");
    const dniMRZ = mrz.nroDocumento.replace(/^0+/, "");
    if (dniFrente && dniMRZ && dniFrente !== dniMRZ) {
      rojo(
        "MRZ_DNI_DISTINTO",
        "El numero de DNI del frente no coincide con el del dorso",
        `Frente: ${ext.dni} - MRZ del dorso: ${mrz.nroDocumento}.`,
      );
    }

    const nacFrente = normFecha(ext.fecha_nacimiento);
    if (nacFrente && mrz.fechaNacimiento && nacFrente !== mrz.fechaNacimiento) {
      rojo(
        "MRZ_NACIMIENTO_DISTINTO",
        "La fecha de nacimiento del frente no coincide con la del dorso",
        `Frente: ${nacFrente} - MRZ del dorso: ${mrz.fechaNacimiento}. La MRZ es la fuente confiable.`,
      );
    }

    const vencFrente = normFecha(ext.fecha_vencimiento);
    if (vencFrente && mrz.fechaVencimiento && vencFrente !== mrz.fechaVencimiento) {
      rojo(
        "MRZ_VENCIMIENTO_DISTINTO",
        "La fecha de vencimiento del frente no coincide con la del dorso",
        `Frente: ${vencFrente} - MRZ del dorso: ${mrz.fechaVencimiento}.`,
      );
    }

    const sexoFrente = String(ext.sexo ?? "").toUpperCase().slice(0, 1);
    if (sexoFrente && mrz.sexo && sexoFrente !== mrz.sexo) {
      rojo(
        "MRZ_SEXO_DISTINTO",
        "El sexo del frente no coincide con el del dorso",
        `Frente: ${sexoFrente} - MRZ del dorso: ${mrz.sexo}.`,
      );
    }

    const apeF = normNombre(ext.apellido);
    const apeM = normNombre(mrz.apellido);
    if (
      apeF && apeM && apeF !== apeM && !apeM.startsWith(apeF) &&
      !apeF.startsWith(apeM)
    ) {
      // Excepcion: los apellidos con caracteres especiales (tipicamente la N,
      // pero tambien otros) se transcriben en la MRZ del dorso usando X de
      // relleno. Ej: "MAGANINI" (con enie en el frente) figura como
      // "MAGANXXINI" en la MRZ. Eso NO es una adulteracion. Si al quitar las X
      // de la MRZ el apellido reconcilia con el del frente, lo aprobamos y lo
      // dejamos mencionado como excepcion (amarillo) en vez de rechazar.
      const apeMsinX = apeM.replace(/X/g, "");
      const apeFsinX = apeF.replace(/X/g, "");
      const reconciliaSinX = !!apeMsinX && (
        apeMsinX === apeFsinX ||
        apeMsinX.startsWith(apeFsinX) ||
        apeFsinX.startsWith(apeMsinX)
      );
      if (apeM.includes("X") && reconciliaSinX) {
        amarillo(
          "MRZ_APELLIDO_CARACTER_ESPECIAL",
          "El apellido tiene un caracter especial que en la MRZ figura como X",
          `Frente: ${apeF} - MRZ del dorso: ${apeM}. En los DNI argentinos la enie ` +
            `(y otros caracteres especiales) se transcriben en la MRZ con X de relleno, ` +
            `por eso el dorso dice X donde el frente tiene la letra especial. La diferencia ` +
            `es normal y NO indica adulteracion: aprobado como excepcion.`,
        );
      } else {
        rojo(
          "MRZ_APELLIDO_DISTINTO",
          "El apellido del frente no coincide con el del dorso",
          `Frente: ${apeF} - MRZ del dorso: ${apeM}.`,
        );
      }
    }
  }

  // --- 2. CUIL --------------------------------------------------------------
  const cuil = ext.cuil
    ? verificarCUIL(String(ext.cuil), String(ext.dni ?? ""), String(ext.sexo ?? ""))
    : null;
  if (cuil) {
    if (!cuil.dvOk) {
      rojo(
        "CUIL_DV_INVALIDO",
        "El digito verificador del CUIL no cierra",
        `CUIL leido: ${ext.cuil}. El verificador modulo 11 no da. Un CUIL real siempre cierra.`,
      );
    }
    if (!cuil.coincideDni && cuil.dniDelCuil) {
      rojo(
        "CUIL_DNI_DISTINTO",
        "El CUIL no corresponde al numero de DNI",
        `El CUIL contiene ${cuil.dniDelCuil} pero el DNI del frente es ${ext.dni}.`,
      );
    }
    if (!cuil.prefijoCoherenteConSexo) {
      amarillo(
        "CUIL_PREFIJO_SEXO",
        "El prefijo del CUIL no coincide con el sexo",
        `Prefijo ${cuil.prefijo} con sexo ${ext.sexo}. Revisar (el 23 es legitimo para ambos).`,
      );
    }
  }

  // --- 3. Coherencia emision + 15 anios = vencimiento -----------------------
  const em = normFecha(ext.fecha_emision);
  const ve = normFecha(ext.fecha_vencimiento);
  if (em && ve) {
    const [de, me, ye] = em.split("/").map(Number);
    const [dv2, mv, yv] = ve.split("/").map(Number);
    if (!(de === dv2 && me === mv && yv - ye === 15)) {
      amarillo(
        "EMISION_VENCIMIENTO_INCOHERENTE",
        "Emision y vencimiento no guardan la distancia de 15 anios",
        `Emision ${em} - Vencimiento ${ve}. El DNI argentino vence exactamente 15 anios despues de la emision.`,
      );
    }
  }

  // --- 4. Forense del archivo ----------------------------------------------
  const caras: Array<[string, ForenseArchivo | null]> = [
    ["frente", e.forenseFrente ?? null],
    ["dorso", e.forenseDorso ?? null],
  ];
  for (const [cara, f] of caras) {
    if (!f) continue;
    if (f.tieneC2PA) {
      rojo(
        "C2PA_GENERADOR",
        `El archivo del ${cara} trae credencial de contenido generado`,
        "La imagen esta firmada con Content Credentials (C2PA): fue creada o editada por una herramienta de IA.",
      );
    }
    if (f.resolucionEnListaNegra && !f.tieneExif) {
      rojo(
        "RESOLUCION_GENERADOR",
        `El ${cara} tiene una resolucion tipica de generador de imagenes`,
        `${f.ancho}x${f.alto} px sin datos de camara. Ninguna camara de celular produce ese tamano exacto; si lo produce la IA generativa.`,
      );
    } else if (f.ambosLadosMultiploDe64 && !f.tieneExif) {
      amarillo(
        "DIMENSIONES_SOSPECHOSAS",
        `El ${cara} tiene dimensiones sospechosas`,
        `${f.ancho}x${f.alto} px: ambos lados son multiplos de 64 y no hay datos de camara. Es el patron de una imagen generada.`,
      );
    }
    // Nota: la ausencia de EXIF por si sola NO genera motivo. WhatsApp borra
    // los metadatos de toda foto que pasa por el, asi que marcarlo pondria en
    // amarillo practicamente todos los DNIs legitimos. Queda como dato en
    // `forense` para el que quiera mirarlo.
  }

  const ff = e.forenseFrente, fd = e.forenseDorso;
  if (
    ff && fd && ff.ancho && fd.ancho &&
    ff.ancho === fd.ancho && ff.alto === fd.alto &&
    (ff.resolucionEnListaNegra || ff.ambosLadosMultiploDe64) &&
    !ff.tieneExif && !fd.tieneExif
  ) {
    amarillo(
      "MISMA_RESOLUCION_EXACTA",
      "Frente y dorso tienen exactamente la misma resolucion",
      `Ambas ${ff.ancho}x${ff.alto} px. Dos fotos sacadas a mano no dan el mismo tamano exacto; si lo dan dos salidas del mismo generador.`,
    );
  }

  // Un PDF no queda en amarillo por ser PDF: le sacamos las imagenes embebidas
  // en su resolucion original y las peritamos igual. Solo avisamos cuando NO se
  // pudieron extraer, porque ahi si quedamos sin evidencia del archivo.
  if (e.origenPDF && !e.pdfImagenesExtraidas) {
    amarillo(
      "PDF_SIN_IMAGENES",
      "No se pudieron extraer las imagenes del PDF",
      "El PDF no trae las fotos en un formato que se pueda peritar. Se verifico el contenido (MRZ, CUIL, fechas) pero no el archivo. Pedir la foto original del celular.",
    );
  }

  // --- 5. Senales visuales del modelo de vision ----------------------------
  const visualesFuertes: string[] = [];
  if (v.ghost_portrait_correcto === false) {
    visualesFuertes.push(
      "el retrato fantasma del dorso esta renderizado como foto realista en vez del grabado de lineas finas",
    );
  }
  if (v.barcode_estructura_valida === false) {
    visualesFuertes.push("el codigo de barras / PDF417 tiene estructura inventada");
  }
  if (v.guilloches_coherentes === false) {
    visualesFuertes.push(
      "las guardas de seguridad (guilloches) se disuelven o no siguen un patron continuo",
    );
  }
  const visualesLeves: string[] = [];
  if (v.tipografia_uniforme === false) {
    visualesLeves.push("tipografia inconsistente entre campos");
  }
  if (v.microimpresion_legible === false) {
    visualesLeves.push("microimpresion ilegible o inventada");
  }
  if (v.fondo_recortado_artificial === true) {
    visualesLeves.push("el DNI parece recortado y pegado sobre un fondo artificial");
  }

  if (
    visualesFuertes.length >= 2 ||
    (visualesFuertes.length >= 1 && v.sospecha_ia === "alta")
  ) {
    rojo(
      "VISUAL_MANIPULACION",
      "El analisis visual encontro elementos de seguridad mal reproducidos",
      visualesFuertes.concat(visualesLeves).join(" - "),
    );
  } else if (
    visualesFuertes.length === 1 || visualesLeves.length >= 2 ||
    v.sospecha_ia === "alta"
  ) {
    amarillo(
      "VISUAL_DUDOSO",
      "El analisis visual encontro algo raro",
      visualesFuertes.concat(visualesLeves).join(" - ") ||
        String(v.motivo_sospecha || ""),
    );
  } else if (v.sospecha_ia === "media") {
    amarillo(
      "VISUAL_SOSPECHA_MEDIA",
      "Sospecha visual de manipulacion",
      String(
        v.motivo_sospecha ||
          "El modelo reporto sospecha media sin poder precisar el motivo.",
      ),
    );
  }

  // --- Veredicto ------------------------------------------------------------
  const hayRojo = motivos.some((m) => m.nivel === "rojo");
  const hayAmarillo = motivos.some((m) => m.nivel === "amarillo");
  const nivel: NivelAutenticidad = hayRojo
    ? "rojo"
    : hayAmarillo
    ? "amarillo"
    : "verde";

  const resumen = hayRojo
    ? "DOCUMENTO ADULTERADO. Los datos del frente contradicen al dorso o el archivo tiene rastros de generacion por IA. No se puede tomar."
    : hayAmarillo
    ? "Documento a revisar. No hay prueba de adulteracion pero faltan verificaciones."
    : "Documento consistente. Frente y dorso cierran y el archivo no muestra rastros de manipulacion.";

  return {
    nivel,
    apto: !hayRojo,
    resumen,
    motivos,
    mrz,
    cuil,
    forense: { frente: e.forenseFrente ?? null, dorso: e.forenseDorso ?? null },
    peritado_at: new Date().toISOString(),
  };
}
