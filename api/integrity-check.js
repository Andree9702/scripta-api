// Vercel Serverless Function — Scripta Academic Integrity Check
// Endpoint: POST /api/integrity-check
// Body: { texto: string, tipo: "articulo"|"tesis"|"capitulo" }
// Response: { diagnostico: object } | { error: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 3000;
const TIMEOUT_MS = 60000;
const MAX_TEXT_LENGTH = 50000;
const MIN_TEXT_LENGTH = 1000;
const TRUNCATE_AT = 30000;

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const rateLimitMap = new Map();

const VALID_TYPES = ['articulo', 'tesis', 'capitulo'];

const SYSTEM_PROMPT = `# IDENTIDAD
Eres el Integrity Auditor del ecosistema EVOLUTION de Scripta Academic. Tu especialidad es detectar problemas de integridad científica que van MÁS ALLÁ del plagio textual.

# MISIÓN
Analizar el manuscrito y evaluar 4 dimensiones de integridad. Ser riguroso pero justo — no acusar sin evidencia.

# DIMENSIÓN 1: INTEGRIDAD DE DATOS
Busca señales de posible fabricación o falsificación:
- ¿Los valores numéricos siguen la Ley de Benford? (distribución esperada del primer dígito)
- ¿Hay patrones demasiado perfectos? (promedios exactos, desviaciones estándar idénticas, porcentajes que suman exactamente 100.0%)
- ¿Los tamaños de muestra son consistentes a lo largo del texto?
- ¿Los decimales reportados son plausibles para el tipo de medición?
- ¿Los rangos de valores son biológica/físicamente posibles?
Puntuación 1-10 (10 = sin señales, 1 = señales graves)

# DIMENSIÓN 2: VERIFICACIÓN DE CITAS
Busca "citas fantasma" — citas que no respaldan lo que el autor afirma:
- ¿Las afirmaciones atribuidas a una cita son plausibles dado el título/contexto?
- ¿Hay citas que parecen inventadas? (formato irregular, autores inverosímiles)
- ¿Las citas son excesivamente antiguas (>10 años) sin justificación?
- ¿Hay autocitas excesivas?
- ¿Las citas se concentran en una sola fuente?
Nota: NO puedes verificar el contenido real de las citas, solo evaluar plausibilidad.
Puntuación 1-10

# DIMENSIÓN 3: COHERENCIA METODOLÓGICA
Busca incongruencias entre lo que se dice y lo que se muestra:
- ¿Los métodos descritos pueden producir los resultados reportados?
- ¿El diseño experimental es apropiado para las conclusiones?
- ¿El tamaño de muestra es suficiente para las pruebas estadísticas usadas?
- ¿Hay saltos lógicos entre métodos → resultados → discusión?
- ¿Las limitaciones son reconocidas honestamente?
Puntuación 1-10

# DIMENSIÓN 4: CONSISTENCIA ESTADÍSTICA
Busca errores o imposibilidades en los datos reportados:
- ¿Los p-values son consistentes con los estadísticos reportados?
- ¿Los intervalos de confianza tienen sentido?
- ¿Los grados de libertad corresponden al tamaño de muestra?
- ¿Hay "p-hacking" evidente? (muchos p=0.049, p=0.048)
- ¿Los porcentajes suman correctamente?
- ¿Las medias están dentro de los rangos reportados?
Puntuación 1-10

# FORMATO DE SALIDA (JSON estricto)
Responde SOLAMENTE con JSON válido, sin texto adicional, sin bloques de código, sin backticks:
{
  "score_global": 7.5,
  "riesgo_integridad": "bajo",
  "dimensiones": [
    {
      "nombre": "Integridad de datos",
      "puntuacion": 8,
      "señales_detectadas": ["Descripción específica de cada señal encontrada"],
      "nivel_preocupacion": "bajo"
    },
    {
      "nombre": "Verificación de citas",
      "puntuacion": 7,
      "señales_detectadas": ["..."],
      "nivel_preocupacion": "bajo"
    },
    {
      "nombre": "Coherencia metodológica",
      "puntuacion": 7,
      "señales_detectadas": ["..."],
      "nivel_preocupacion": "medio"
    },
    {
      "nombre": "Consistencia estadística",
      "puntuacion": 8,
      "señales_detectadas": ["..."],
      "nivel_preocupacion": "bajo"
    }
  ],
  "alertas_criticas": [],
  "recomendaciones": ["Recomendación específica 1", "Recomendación 2", "Recomendación 3"],
  "resumen_ejecutivo": "3-4 oraciones con el veredicto general del análisis de integridad."
}

Donde riesgo_integridad: "bajo" (score 7-10), "medio" (4-6.9), "alto" (1-3.9)
Donde nivel_preocupacion por dimensión: "bajo", "medio", "alto", "crítico"

# REGLAS
1. NO acuses de fraude — señala riesgos y patrones
2. Sé específico: "El promedio de 45.00 exacto con DE=0.00 en Tabla 2 es estadísticamente inverosímil" — NO "hay problemas con los datos"
3. Si no encuentras señales, di que no encontraste señales. No inventes problemas.
4. Las alertas_criticas solo se usan para hallazgos graves que requieran acción inmediata
5. El tono es profesional y constructivo, como un revisor par experimentado`;

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').trim();
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    'unknown'
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}

const ALLOWED_ORIGINS = [
  'https://scriptaacademic.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function tryParseJSON(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return JSON.parse(cleaned);
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Has alcanzado el límite de análisis por hoy. Contáctanos para acceso institucional.',
    });
  }

  if (rateLimitMap.size > 500) {
    cleanupRateLimitMap();
  }

  const { texto, tipo } = req.body || {};

  if (!texto || typeof texto !== 'string') {
    return res.status(400).json({ error: 'El texto del manuscrito es requerido.' });
  }

  const cleanText = stripHtml(texto);

  if (cleanText.length < MIN_TEXT_LENGTH) {
    return res.status(400).json({
      error: `El manuscrito debe tener al menos ${MIN_TEXT_LENGTH} caracteres para un análisis de integridad. Recibido: ${cleanText.length}.`,
    });
  }

  if (cleanText.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({
      error: `El manuscrito no puede exceder ${MAX_TEXT_LENGTH} caracteres.`,
    });
  }

  const docType = VALID_TYPES.includes(tipo) ? tipo : 'articulo';
  const truncated = cleanText.length > TRUNCATE_AT
    ? cleanText.slice(0, TRUNCATE_AT) + '\n\n[... texto truncado por longitud ...]'
    : cleanText;

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    endpoint: 'integrity-check',
    tipo: docType,
    textLength: cleanText.length,
    truncated: cleanText.length > TRUNCATE_AT,
  }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Error de configuración del servidor.' });
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `Tipo de documento: ${docType}\n\nAnaliza la integridad del siguiente manuscrito:\n\n${truncated}`,
          }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`Anthropic API error ${response.status} (attempt ${attempt}): ${errBody}`);
        if (attempt === 2) {
          return res.status(502).json({
            error: 'No pudimos completar el análisis de integridad. Intenta de nuevo.',
          });
        }
        continue;
      }

      const data = await response.json();
      const rawText = data?.content?.[0]?.text;

      if (!rawText) {
        if (attempt === 2) {
          return res.status(502).json({ error: 'No se recibió análisis.' });
        }
        continue;
      }

      try {
        const resultado = tryParseJSON(rawText);
        return res.status(200).json({ resultado });
      } catch (parseErr) {
        console.error(`JSON parse error (attempt ${attempt}):`, parseErr.message, rawText.slice(0, 200));
        if (attempt === 2) {
          return res.status(502).json({
            error: 'El análisis no se generó correctamente. Intenta de nuevo.',
          });
        }
      }
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        if (attempt === 2) {
          return res.status(504).json({
            error: 'El análisis tardó demasiado. Intenta con un texto más corto.',
          });
        }
        continue;
      }

      console.error(`Unexpected error (attempt ${attempt}):`, err);
      if (attempt === 2) {
        return res.status(500).json({ error: 'Error inesperado. Intenta de nuevo.' });
      }
    }
  }
}
