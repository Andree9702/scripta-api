// Vercel Serverless Function — Scripta Academic Sample Generator
// Endpoint: POST /api/generate-sample
// Body: { tema: string, disciplina?: string, tipo?: string }
// Response: { texto: string } | { error: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 500;
const TIMEOUT_MS = 30000;

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// In-memory rate limit store (resets on cold start — fine for MVP)
const rateLimitMap = new Map();

const SYSTEM_PROMPT = `Eres un redactor académico experto del servicio Scripta Academic. Tu tarea es generar UN SOLO párrafo académico de demostración (180–250 palabras) sobre el tema proporcionado.

INSTRUCCIONES ESTRICTAS:
1. Escribe en español académico formal con terminología especializada de la disciplina indicada
2. El párrafo debe ser del tipo indicado (introducción, marco teórico, discusión o conclusión)
3. Incluye exactamente 3 citas en formato APA 7 con autores y años verosímiles (ej: García-López et al., 2023; Müller & Chen, 2024; Rodríguez-Vega & Thompson, 2025)
4. Las citas deben estar integradas naturalmente en el texto, no amontonadas al final
5. Demuestra dominio de conectores académicos: "En este contexto,", "No obstante,", "Resulta pertinente señalar que", "De manera análoga,", "En concordancia con lo expuesto,"
6. El texto debe tener cohesión interna impecable — cada oración debe conectar lógicamente con la anterior
7. Termina con una oración de transición que sugiera continuidad hacia el siguiente párrafo
8. NO incluyas título, encabezado, ni etiquetas — solo el párrafo puro
9. Este es un DEMO comercial — debe ser TAN bueno que el cliente quiera contratar inmediatamente
10. Evita frases genéricas como "es importante mencionar" o "cabe destacar" — sé específico y técnico`;

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

// Clean up old entries periodically (prevent memory leak)
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

export default async function handler(req, res) {
  // CORS
  setCorsHeaders(req, res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Rate limiting
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Has alcanzado el límite de muestras gratuitas. ¡Contáctanos para ver más!',
    });
  }

  // Periodic cleanup
  if (rateLimitMap.size > 1000) {
    cleanupRateLimitMap();
  }

  // Parse & validate
  const { tema, disciplina, tipo } = req.body || {};

  if (!tema || typeof tema !== 'string') {
    return res.status(400).json({ error: 'El tema es requerido.' });
  }

  const cleanTema = stripHtml(tema);

  if (cleanTema.length < 10) {
    return res.status(400).json({ error: 'El tema debe tener al menos 10 caracteres.' });
  }

  if (cleanTema.length > 500) {
    return res.status(400).json({ error: 'El tema no puede exceder 500 caracteres.' });
  }

  const disc = stripHtml(String(disciplina || 'Ciencias'));
  const tipoTexto = stripHtml(String(tipo || 'Introducción'));

  // Logging for Vercel Dashboard
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    disciplina: disc,
    tipo: tipoTexto,
    temaLength: cleanTema.length,
  }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Error de configuración del servidor.' });
  }

  // Call Anthropic API
  const userMessage = `Tema: ${cleanTema}\nDisciplina: ${disc}\nTipo de párrafo: ${tipoTexto}`;

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
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Anthropic API error ${response.status}: ${errBody}`);
      return res.status(502).json({
        error: 'No pudimos generar la muestra en este momento. Intenta de nuevo en unos minutos.',
      });
    }

    const data = await response.json();
    const texto = data?.content?.[0]?.text;

    if (!texto) {
      return res.status(502).json({
        error: 'No pudimos generar la muestra. Intenta de nuevo.',
      });
    }

    return res.status(200).json({ texto });
  } catch (err) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'La generación tardó demasiado. Intenta con un tema más específico.',
      });
    }

    console.error('Unexpected error:', err);
    return res.status(500).json({
      error: 'Error inesperado. Intenta de nuevo.',
    });
  }
}
