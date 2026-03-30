// Vercel Serverless Function — Academic Translation (ES → EN)
// Endpoint: POST /api/translate-academic
// Body: { texto: string, disciplina: string, revista_objetivo?: string }
// Response: { resultado: { texto_traducido, glosario_tecnico, notas } }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 45000;

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const rateLimitMap = new Map();

const SYSTEM_PROMPT = `Eres el Translation Agent del ecosistema EVOLUTION de Scripta Academic.

MISIÓN: Traducir texto académico del español al inglés manteniendo rigor terminológico.

REGLAS:
1. Terminología técnica estándar de la disciplina en inglés — NO traducciones literales
2. Registro académico formal (tercera persona, voz pasiva cuando corresponda)
3. Conectores académicos en inglés: "Furthermore", "Conversely", "Notably"
4. Citas entre paréntesis (Apellido et al., 2024) se mantienen EXACTAMENTE igual
5. Pruebas estadísticas en inglés (chi-square, ANOVA, t-test)
6. Especies en latín cursiva
7. Siglas: nombre completo la primera vez en inglés, luego sigla
8. NO agregues ni quites contenido
9. Si hay ambigüedad técnica, incluye nota

FORMATO DE SALIDA (JSON estricto, sin backticks):
{
  "texto_traducido": "...",
  "glosario_tecnico": [{"es": "...", "en": "..."}],
  "notas": "..."
}`;

function stripHtml(s) { return s.replace(/<[^>]*>/g, '').trim(); }
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown';
}
function checkRateLimit(ip) {
  const now = Date.now();
  const e = rateLimitMap.get(ip);
  if (!e || now - e.windowStart > RATE_LIMIT_WINDOW_MS) { rateLimitMap.set(ip, { windowStart: now, count: 1 }); return true; }
  if (e.count >= RATE_LIMIT_MAX) return false;
  e.count++; return true;
}

const ALLOWED_ORIGINS = ['https://scriptaacademic.com', 'http://localhost:5173', 'http://localhost:3000'];
function setCorsHeaders(req, res) {
  const o = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function tryParseJSON(text) {
  let c = text.trim();
  if (c.startsWith('```')) c = c.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(c);
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Límite de traducciones alcanzado por hoy.' });

  const { texto, disciplina, revista_objetivo } = req.body || {};
  if (!texto || typeof texto !== 'string') return res.status(400).json({ error: 'El texto es requerido.' });

  const clean = stripHtml(texto);
  if (clean.length < 100) return res.status(400).json({ error: `Mínimo 100 caracteres. Recibido: ${clean.length}.` });
  if (clean.length > 15000) return res.status(400).json({ error: 'Máximo 15,000 caracteres.' });

  const disc = stripHtml(String(disciplina || 'General'));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Error de configuración del servidor.' });

  const userMsg = `Disciplina: ${disc}${revista_objetivo ? `\nRevista objetivo: ${revista_objetivo}` : ''}\n\nTexto a traducir:\n${clean}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) { console.error(`API error ${response.status}`); return res.status(502).json({ error: 'Error al traducir. Intenta de nuevo.' }); }

    const data = await response.json();
    const raw = data?.content?.[0]?.text;
    if (!raw) return res.status(502).json({ error: 'No se recibió traducción.' });

    try {
      return res.status(200).json({ resultado: tryParseJSON(raw) });
    } catch {
      return res.status(200).json({ resultado: { texto_traducido: raw, glosario_tecnico: [], notas: '' } });
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Traducción tardó demasiado.' });
    return res.status(500).json({ error: 'Error inesperado.' });
  }
}
