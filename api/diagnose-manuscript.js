// Vercel Serverless Function — Scripta Academic Manuscript Diagnostic
// Endpoint: POST /api/diagnose-manuscript
// Body: { texto: string }
// Response: { diagnostico: object } | { error: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 45000;
const MAX_TEXT_LENGTH = 50000;
const MIN_TEXT_LENGTH = 500;
const TRUNCATE_AT = 30000;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const rateLimitMap = new Map();

const SYSTEM_PROMPT = `# IDENTIDAD
Eres el Evaluador de Manuscritos del ecosistema EVOLUTION de Scripta Academic. Tu especialidad es el análisis rápido de manuscritos académicos para identificar fortalezas, debilidades y riesgo de desk-rejection.

# MISIÓN
Analizar el manuscrito proporcionado y generar un diagnóstico estructurado en formato JSON.

# INSTRUCCIONES
Evalúa el manuscrito en estas 6 dimensiones (puntuación 1-10 cada una):

1. ESTRUCTURA: ¿Tiene las secciones esperadas? (IMRyD para artículos, capítulos coherentes para libros)
2. CLARIDAD: ¿La redacción es clara, concisa y sin ambigüedades?
3. RIGOR METODOLÓGICO: ¿La metodología está bien descrita y es reproducible?
4. REFERENCIAS: ¿Las citas son suficientes, actuales (últimos 5 años) y relevantes?
5. ORIGINALIDAD: ¿Aporta algo nuevo al campo? ¿La pregunta de investigación está clara?
6. FORMATO: ¿Sigue normas APA/Vancouver/editorial? ¿Tablas y figuras correctas?

# FORMATO DE SALIDA (JSON estricto)
Responde SOLAMENTE con JSON válido, sin texto adicional, sin bloques de código, sin backticks:
{
  "puntuacion_global": 7.5,
  "riesgo_desk_rejection": "medio",
  "dimensiones": [
    { "nombre": "Estructura", "puntuacion": 8, "comentario": "..." },
    { "nombre": "Claridad", "puntuacion": 7, "comentario": "..." },
    { "nombre": "Rigor metodológico", "puntuacion": 6, "comentario": "..." },
    { "nombre": "Referencias", "puntuacion": 7, "comentario": "..." },
    { "nombre": "Originalidad", "puntuacion": 8, "comentario": "..." },
    { "nombre": "Formato", "puntuacion": 7, "comentario": "..." }
  ],
  "fortalezas": ["...", "...", "..."],
  "debilidades": ["...", "...", "..."],
  "recomendaciones": ["...", "...", "..."],
  "revistas_sugeridas": ["...", "...", "..."],
  "servicio_recomendado": "Paquete Paper a Publicación",
  "resumen_ejecutivo": "Párrafo de 3-4 oraciones con el veredicto general."
}

Donde riesgo_desk_rejection es: "bajo" (7-10), "medio" (4-6.9), "alto" (1-3.9)
Cada comentario debe ser específico al manuscrito, no genérico.
Las revistas sugeridas deben ser revistas reales, indexadas, en el área del manuscrito.`;

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
  // Strip markdown code fences if present
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
      error: 'Has alcanzado el límite de diagnósticos por hoy. Intenta mañana o contáctanos directamente.',
    });
  }

  if (rateLimitMap.size > 500) {
    cleanupRateLimitMap();
  }

  const { texto } = req.body || {};

  if (!texto || typeof texto !== 'string') {
    return res.status(400).json({ error: 'El texto del manuscrito es requerido.' });
  }

  const cleanText = stripHtml(texto);

  if (cleanText.length < MIN_TEXT_LENGTH) {
    return res.status(400).json({
      error: `El manuscrito debe tener al menos ${MIN_TEXT_LENGTH} caracteres. Recibido: ${cleanText.length}.`,
    });
  }

  if (cleanText.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({
      error: `El manuscrito no puede exceder ${MAX_TEXT_LENGTH} caracteres.`,
    });
  }

  // Truncate for API call if needed
  const truncated = cleanText.length > TRUNCATE_AT
    ? cleanText.slice(0, TRUNCATE_AT) + '\n\n[... texto truncado por longitud ...]'
    : cleanText;

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    endpoint: 'diagnose-manuscript',
    textLength: cleanText.length,
    truncated: cleanText.length > TRUNCATE_AT,
  }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Error de configuración del servidor.' });
  }

  // Try up to 2 times to get valid JSON
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
            content: `Analiza el siguiente manuscrito y genera el diagnóstico en JSON:\n\n${truncated}`,
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
            error: 'No pudimos completar el diagnóstico. Intenta de nuevo en unos minutos.',
          });
        }
        continue;
      }

      const data = await response.json();
      const rawText = data?.content?.[0]?.text;

      if (!rawText) {
        if (attempt === 2) {
          return res.status(502).json({ error: 'No se recibió diagnóstico.' });
        }
        continue;
      }

      try {
        const diagnostico = tryParseJSON(rawText);
        return res.status(200).json({ diagnostico });
      } catch (parseErr) {
        console.error(`JSON parse error (attempt ${attempt}):`, parseErr.message, rawText.slice(0, 200));
        if (attempt === 2) {
          return res.status(502).json({
            error: 'El diagnóstico no se generó correctamente. Intenta de nuevo.',
          });
        }
      }
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        if (attempt === 2) {
          return res.status(504).json({
            error: 'El diagnóstico tardó demasiado. Intenta con un manuscrito más corto.',
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
