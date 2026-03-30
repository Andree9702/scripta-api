// Vercel Serverless Function — Scripta Academic Sample Generator
// Endpoint: POST /api/generate-sample
// Body: { tema: string, disciplina?: string, tipo?: string }
// Response: { texto: string } | { error: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 300;
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
  const url = `https://api.crossref.org/works?query=${query}&rows=5&sort=relevance&select=DOI,title,author,published-print,published-online,container-title`;

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
        // Must have at least one author with a family name
        return item.author?.some(a => a.family);
      })
      .slice(0, 3);

    return items.map(item => {
      const authors = (item.author || []).filter(a => a.family);
      const authorStr = authors.length <= 2
        ? authors.map(a => `${a.family}, ${(a.given || '').charAt(0)}.`).join(' & ')
        : `${authors[0].family}, ${(authors[0].given || '').charAt(0)}., et al.`;

      const year = item['published-print']?.['date-parts']?.[0]?.[0]
        || item['published-online']?.['date-parts']?.[0]?.[0]
        || 'n.d.';

      return {
        doi: item.DOI,
        title: item.title?.[0] || '',
        authors: authorStr,
        year,
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

  return `Eres un Domain Expert del ecosistema EVOLUTION de Scripta Academic, especializado en ${disciplina}.

REGLAS ABSOLUTAS — INCUMPLIR CUALQUIERA ES INACEPTABLE:
1. Escribe EXACTAMENTE 4 oraciones. No 3. No 5. No 6. CUATRO.
2. Máximo 80 palabras en total. Cuenta mentalmente.
3. Español académico formal con terminología técnica de ${disciplina}.
4. ${citations.length > 0
    ? `Integra las citas reales proporcionadas abajo — NO inventes otras:
${citations.map(c => {
    const firstAuthor = c.authors.split(',')[0].trim();
    return `   (${firstAuthor}, ${c.year})`;
  }).join('\n')}`
    : `No hay citas disponibles. NO inventes ninguna. Usa "la evidencia disponible sugiere..." o "diversos estudios han documentado...".`}
5. Primera oración: contexto del problema.
6. Segunda oración: con cita integrada (Apellido et al., Año).
7. Tercera oración: hallazgo o argumento clave con otra cita.
8. Cuarta oración: implicación o transición.
9. NO incluyas título, encabezado, saludo, ni despedida. Solo las 4 oraciones.
${citationContext}

RECUERDA: SI ESCRIBES MÁS DE 4 ORACIONES, HAS FALLADO TU MISIÓN.`;
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

    // Append references block server-side (deterministic, never hallucinated)
    let output = texto.trim();
    if (citations.length > 0) {
      const refsBlock = citations.map(c =>
        `${c.authors} (${c.year}). ${c.title}. ${c.journal}. https://doi.org/${c.doi}`
      ).join('\n');
      output += `\n\n---REFERENCIAS---\n${refsBlock}`;
    }

    return res.status(200).json({ texto: output });
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
