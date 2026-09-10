// Prompt del peritaje de DNI argentino. Vive aparte para que lo compartan
// `analizar-dni` (formularios online) y `peritar-dni` (administracion-tga),
// y para poder testearlo sin levantar la Edge Function.

export const SYSTEM_PROMPT = `Sos un perito documentologico que analiza fotos de DNI argentinos (nuevo formato tarjeta).
Devolves SIEMPRE un unico objeto JSON valido, sin texto antes ni despues, sin markdown.
Analizas DOS imagenes: normalmente la primera es el FRENTE del DNI y la segunda el DORSO.
Si vienen al reves, identificalas por su contenido y analizalas igual: el FRENTE tiene la
foto del titular, el numero de documento y las fechas; el DORSO tiene el domicilio, la
huella dactilar, el CUIL y la MRZ (las 3 lineas con chevrones).
No inventes datos: si no podes leer un campo con certeza, poner null.

REGLA CRITICA: transcribi SIEMPRE literalmente, caracter por caracter, lo que ves.
NUNCA "corrijas", completes ni normalices un dato que te parezca raro: justamente esas
inconsistencias son la evidencia de que el documento fue alterado. Si el frente dice una
fecha y el dorso dice otra, transcribi las dos como estan.`;

export function buildUserPrompt(datero: Record<string, string>): string {
  return `Analiza las dos imagenes adjuntas (frente y dorso de un DNI argentino).

Devolveme un JSON con esta estructura exacta:

{
  "calidad": {
    "frente": {
      "ok": boolean,
      "legible": boolean,
      "blur": boolean,
      "bordes_cortados": boolean,
      "fondo_blanco": boolean,  // true si el DNI esta apoyado sobre fondo blanco/claro liso
      "motivo": string  // "" si ok, sino descripcion corta en espanol
    },
    "dorso": {
      "ok": boolean,
      "legible": boolean,
      "blur": boolean,
      "bordes_cortados": boolean,
      "fondo_blanco": boolean,
      "motivo": string
    },
    "ok_global": boolean  // true solo si frente.ok && dorso.ok
  },
  "extraido": {
    "nombre": string | null,         // solo nombres de pila
    "apellido": string | null,
    "dni": string | null,            // solo digitos
    "sexo": string | null,           // "M" o "F"
    "fecha_nacimiento": string | null,  // formato DD/MM/AAAA
    "fecha_emision": string | null,
    "fecha_vencimiento": string | null,
    "nacionalidad": string | null,
    "domicilio": string | null,      // texto completo del domicilio como aparece en el DNI (calle + numero + piso/dpto si estan)
    "calle": string | null,          // solo el nombre de la calle (sin numero)
    "altura": string | null,         // solo el numero de altura
    "barrio": string | null,         // si localidad leida es un barrio de CABA (Colegiales, Palermo, Belgrano, Caballito, Recoleta, Nunez, etc.), poner ese nombre aca. Si es un municipio o localidad real, dejar null.
    "localidad": string | null,      // localidad administrativa real. IMPORTANTE: si el DNI muestra un BARRIO de CABA, corregilo a "CABA". Si muestra un partido del GBA (Vicente Lopez, San Isidro, La Matanza, etc.) dejalo como esta. Si el DNI dice directamente "CABA" o "CAPITAL FEDERAL" o similar, poner "CABA".
    "provincia": string | null,      // IMPORTANTE: si la localidad es CABA o un barrio de CABA, provincia = "CABA". Si es un partido del GBA, provincia = "Buenos Aires".
    "codigo_postal": string | null,  // CP de 4 digitos (o 8 con letra-CP moderno); si no aparece en el DNI, infiri de localidad+calle usando tu conocimiento de Argentina. Si no estas seguro, null.
    "cuil": string | null            // del dorso si aparece
  },
  "mrz": {
    // Las 3 lineas de la zona legible por maquina del DORSO (abajo de todo,
    // en tipografia monoespaciada con muchos chevrones "<").
    // Transcribi CADA LINEA COMPLETA, literal, incluyendo TODOS los chevrones.
    // Son 30 caracteres por linea. Si no se leen, poner null.
    "linea1": string | null,   // arranca con "IDARG"
    "linea2": string | null,   // arranca con la fecha de nacimiento AAMMDD
    "linea3": string | null    // APELLIDO<<NOMBRES
  },
  "autenticidad_visual": {
    // Peritaje visual. Respondes true si el elemento se ve CORRECTO / autentico,
    // false si esta mal reproducido, null si no podes determinarlo.
    "ghost_portrait_correcto": boolean | null,
    // El dorso tiene un retrato fantasma del titular a la izquierda. En un DNI
    // real es un GRABADO de lineas finas azules (tipo billete), NO una foto.
    // Si se ve como una fotografia realista o con sombreado continuo, es false.
    "guilloches_coherentes": boolean | null,
    // Las guardas de seguridad (patrones de lineas entrelazadas, la roseta del
    // dorso, el mapa de fondo del frente). false si se disuelven, se cortan,
    // se repiten mal o pierden continuidad.
    "tipografia_uniforme": boolean | null,
    // false si algun campo tiene una fuente, grosor, espaciado o alineacion
    // distinta al resto (senal de texto reescrito encima).
    "barcode_estructura_valida": boolean | null,
    // El frente tiene un codigo de barras 2D (PDF417) al lado del numero de
    // tramite. false si los modulos se ven como ruido aleatorio, sin las barras
    // de inicio/fin ni la estructura de filas regulares que tiene un PDF417 real.
    "microimpresion_legible": boolean | null,
    // Textos diminutos impresos. false si se ven como garabatos o letras inventadas.
    "fondo_recortado_artificial": boolean | null,
    // true si el DNI parece recortado y pegado sobre un fondo liso perfecto,
    // sin sombras coherentes ni continuidad con la superficie de apoyo.
    "senales": string[],
    // Lista corta de anomalias concretas que notaste (en espanol). [] si ninguna.
    "sospecha_ia": "no" | "baja" | "media" | "alta",
    // Tu evaluacion global de si la imagen fue generada o retocada con IA.
    "motivo_sospecha": string
    // "" si sospecha_ia es "no".
  }
}

Como peritar la MRZ:
- Esta SIEMPRE en el dorso, ocupando el tercio inferior, en tipografia monoespaciada.
- Copiala caracter por caracter. Los simbolos "<" son parte del dato, no relleno decorativo.
- Si una linea esta cortada o borrosa y no podes leerla entera, poner null en vez de adivinar.

Criterios de calidad:
- "ok": true solo si TODAS las condiciones se cumplen: legible, sin blur, 4 esquinas visibles, fondo blanco.
- "bordes_cortados": true si falta algun borde del DNI (ej. la esquina se sale del encuadre).
- "blur": true si hay movimiento, foco malo, o texto borroso.
- "fondo_blanco": true SOLO si el DNI esta apoyado sobre una superficie blanca (o muy clara) y lisa que hace contraste con el color del DNI. false si esta sobre madera, tela, alfombra, superficie con patron, color oscuro, o sobre la mano. El fondo blanco es importante porque hace que los bordes del DNI sean nitidamente distinguibles.

Datos que el cliente completo en el formulario (solo para tu contexto, NO los uses para completar campos si no se leen en la imagen):
${JSON.stringify(datero, null, 2)}

Respondeme SOLO el JSON. Nada mas.`;
}
