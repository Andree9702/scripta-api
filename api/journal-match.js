// Vercel Serverless Function — Journal Matching
// Endpoint: POST /api/journal-match
// Body: { titulo: string, abstract: string, disciplina: string, keywords: string[] }
// Response: { revistas: [...] }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 45000;
const CROSSREF_TIMEOUT_MS = 5000;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const rateLimitMap = new Map();

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

async function findJournals(titulo, keywords) {
  const queries = [titulo, ...(keywords || []).slice(0, 2)];
  const journals = new Map();

  for (const q of queries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CROSSREF_TIMEOUT_MS);
    try {
      const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=10&select=container-title,ISSN,publisher`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'ScriptaAcademic/1.0 (mailto:info@scriptaacademic.com)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await r.json();
      for (const item of (data.message?.items || [])) {
        const name = item['container-title']?.[0];
        if (name && !journals.has(name)) {
          journals.set(name, { nombre: name, issn: item.ISSN?.[0] || '', publisher: item.publisher || '' });
        }
      }
    } catch { clearTimeout(timer); }
  }
  return Array.from(journals.values()).slice(0, 10);
}

const SYSTEM_PROMPT = `Eres el Journal Matching Agent del ecosistema EVOLUTION de Scripta Academic.

MISIÓN: De la lista de revistas encontradas en CrossRef y tu conocimiento, selecciona las 5 más adecuadas para este manuscrito.

REGLAS:
1. Evalúa fit temático entre abstract y scope de cada revista
2. Prioriza probabilidad de aceptación sobre factor de impacto
3. Incluye al menos 1 revista latinoamericana indexada si existe en la lista
4. Incluye al menos 1 open access
5. Razón específica para cada una — NO genérica
6. Puedes agregar revistas que no estén en la lista de CrossRef si son conocidas y relevantes

FORMATO (JSON array de 5, sin backticks):
[{"nombre":"...","issn":"...","publisher":"...","tipo_acceso":"open_access|subscription","razon":"...","probabilidad_aceptacion":"alta|media|baja","tiempo_revision_estimado":"4-8 semanas"}]`;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Límite alcanzado por hoy.' });

  const { titulo, abstract, disciplina, keywords } = req.body || {};
  if (!titulo || stripHtml(titulo).length < 10) return res.status(400).json({ error: 'Título mínimo 10 caracteres.' });
  if (!abstract || stripHtml(abstract).length < 100) return res.status(400).json({ error: 'Abstract mínimo 100 caracteres.' });

  const cleanTitle = stripHtml(titulo);
  const cleanAbstract = stripHtml(abstract);
  const disc = stripHtml(String(disciplina || 'General'));
  const kw = Array.isArray(keywords) ? keywords.map(k => stripHtml(String(k))).filter(Boolean) : [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Error de configuración del servidor.' });

  // Step 1: CrossRef journal lookup
  const crossrefJournals = await findJournals(cleanTitle, kw);

  console.log(JSON.stringify({ endpoint: 'journal-match', crossrefFound: crossrefJournals.length }));

  // Step 2: Claude evaluates and recommends
  const journalList = crossrefJournals.length > 0
    ? `\nRevistas encontradas en CrossRef:\n${crossrefJournals.map((j, i) => `${i + 1}. ${j.nombre} (ISSN: ${j.issn}, Publisher: ${j.publisher})`).join('\n')}`
    : '\nNo se encontraron revistas en CrossRef. Usa tu conocimiento para sugerir 5 revistas reales.';

  const userMsg = `Título: ${cleanTitle}\nAbstract: ${cleanAbstract}\nDisciplina: ${disc}\nKeywords: ${kw.join(', ')}${journalList}`;

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
    if (!response.ok) return res.status(502).json({ error: 'Error al buscar revistas.' });

    const data = await response.json();
    const raw = data?.content?.[0]?.text;
    if (!raw) return res.status(502).json({ error: 'No se recibió resultado.' });

    try {
      const revistas = tryParseJSON(raw);
      return res.status(200).json({ revistas: Array.isArray(revistas) ? revistas : [] });
    } catch {
      return res.status(502).json({ error: 'Formato de respuesta inválido. Intenta de nuevo.' });
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Búsqueda tardó demasiado.' });
    return res.status(500).json({ error: 'Error inesperado.' });
  }
}
