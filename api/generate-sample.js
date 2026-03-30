// Vercel Serverless Function — Scripta Academic Sample Generator
// Endpoint: POST /api/generate-sample
// Body: { tema: string, disciplina?: string, tipo?: string }
// Response: { texto: string } | { error: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 500;
const TIMEOUT_MS = 30000;
const CROSSREF_TIMEOUT_MS = 5000;

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// In-memory rate limit store (resets on cold start — fine for MVP)
const rateLimitMap = new Map();

// ─── CrossRef citation lookup ──────────────────────────────────────────────────

async function fetchRealCitations(tema, disciplina) {
  // CrossRef works best with English keywords; keep original query as fallback context
  const query = encodeURIComponent(`${tema} ${disciplina}`);
  const url = `https://api.crossref.org/works?query=${query}&rows=5&sort=relevance&filter=has-abstract:true&select=DOI,title,author,published-print,published-online,container-title`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ScriptaAcademic/1.0 (mailto:info@scriptaacademic.com)' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json();

    const items = (data.message?.items || [])
      .filter(item => {
        // Must have at least one author with a family name and a valid year
        const hasAuthor = item.author?.some(a => a.family);
        const year = item['published-print']?.['date-parts']?.[0]?.[0]
          || item['published-online']?.['date-parts']?.[0]?.[0];
        return hasAuthor && year && year >= 2015;
      })
      .slice(0, 3);

    return items.map(item => {
      const authors = (item.author || []).filter(a => a.family);
      const authorStr = authors.length <= 2
        ? authors.map(a => `${a.family}, ${(a.given || '').charAt(0)}.`).join(' & ')
        : `${authors[0].family}, ${(authors[0].given || '').charAt(0)}., et al.`;

      return {
        doi: item.DOI,
        title: item.title?.[0] || '',
        authors: authorStr,
        year: item['published-print']?.['date-parts']?.[0]?.[0]
          || item['published-online']?.['date-parts']?.[0]?.[0],
        journal: item['container-title']?.[0] || '',
      };
    });
  } catch {
    return [];
  }
}

// ─── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(disciplina, citations) {
  const citationContext = citations.length > 0
    ? `\n\nCITAS REALES VERIFICADAS (DEBES usar estas, NO inventes otras):\n${citations.map((c, i) =>
        `${i + 1}. ${c.authors} (${c.year}). ${c.title}. ${c.journal}. DOI: ${c.doi}`
      ).join('\n')}`
    : '\n\nNo se encontraron citas externas. NO inventes citas. En su lugar, haz afirmaciones respaldables y usa expresiones como "la evidencia disponible sugiere..." o "diversos estudios han documentado...".';

  return `Eres un Domain Expert del ecosistema EVOLUTION de Scripta Academic, especializado en ${disciplina}. Tu tarea es generar UNA MUESTRA de redacción académica.

REGLAS CRÍTICAS — VIOLACIÓN = FALLO:
- Exactamente 4-5 oraciones. Ni más, ni menos. Cuenta antes de responder.
- Español académico formal con terminología técnica de ${disciplina}.${citations.length > 0
    ? `
- CITAS: Usa ÚNICAMENTE las citas de la lista de abajo. Si fabricas una cita que no está en la lista, HAS FALLADO.`
    : `
- NO HAY CITAS DISPONIBLES. No inventes ninguna. Usa frases como "la evidencia disponible sugiere..." o "diversos estudios han documentado...".`}
- Conectores académicos precisos (no "cabe destacar" ni "es importante").
- NO incluyas título ni encabezados. Solo el párrafo y las referencias.
- Última oración: transición que sugiera continuidad.
${citationContext}

FORMATO EXACTO DE RESPUESTA (no te desvíes):

[Párrafo de 4-5 oraciones aquí]

---REFERENCIAS---
${citations.length > 0 ? citations.map(c =>
    `${c.authors} (${c.year}). ${c.title}. *${c.journal}*. https://doi.org/${c.doi}`
  ).join('\n') : '(Sin referencias externas para esta muestra)'}

Responde AHORA. Solo el párrafo y el bloque de referencias. Nada más.`;
}

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

  // Step 1: Fetch real citations from CrossRef
  const citations = await fetchRealCitations(cleanTema, disc);

  console.log(JSON.stringify({
    step: 'crossref',
    citationsFound: citations.length,
    dois: citations.map(c => c.doi),
  }));

  // Step 2: Build agent-style prompt with real citations
  const systemPrompt = buildSystemPrompt(disc, citations);
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
        system: systemPrompt,
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
