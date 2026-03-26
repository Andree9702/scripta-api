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

const SYSTEM_PROMPT = `Eres un redactor académico experto de Scripta Academic. Genera UN SOLO párrafo académico de demostración (150–250 palabras) sobre el tema proporcionado.

Reglas:
- Escribe en español académico formal
- Usa terminología especializada de la disciplina indicada
- Incluye 2–3 citas ficticias pero realistas en formato APA 7 (ej: García-López et al., 2023; Müller & Chen, 2024)
- El párrafo debe ser del tipo indicado (introducción, marco teórico, discusión o conclusión)
- NO incluyas título ni encabezado, solo el párrafo
- El texto debe demostrar rigor científico, cohesión textual y dominio disciplinar
- Termina con una oración de transición que sugiera continuidad
- Este es un DEMO para mostrar calidad, hazlo impresionante`;

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

export default async function handler(req, res) {
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
