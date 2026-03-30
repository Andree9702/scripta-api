// Vercel Serverless Function — Cover Letter Generator
// Endpoint: POST /api/cover-letter
// Body: { titulo: string, abstract: string, revista: string, autores: string, disciplina: string, highlights?: string[] }
// Response: { cover_letter: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1500;
const TIMEOUT_MS = 30000;

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

const SYSTEM_PROMPT = `Eres el Cover Letter Agent del ecosistema EVOLUTION de Scripta Academic.

MISIÓN: Redactar cover letter profesional en inglés para el editor de la revista.

ESTRUCTURA:
1. Dear Editor-in-Chief,
2. Presentación del manuscrito (título, tipo de estudio, hallazgo principal)
3. Por qué es relevante para ESTA revista (mencionar scope)
4. Contribución original al campo
5. Declaraciones: no enviado simultáneamente, autores aprobaron, sin conflictos de interés
6. Cierre formal con datos del autor corresponsal

REGLAS:
1. Máximo 350 palabras
2. Profesional, conciso, convincente pero no arrogante
3. Menciona 1-2 hallazgos concretos del abstract
4. NO frases genéricas como "We believe our paper is a good fit"

FORMATO: Texto plano de la carta. NO JSON. NO backticks.`;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Límite alcanzado por hoy.' });

  const { titulo, abstract, revista, autores, disciplina, highlights } = req.body || {};
  if (!titulo || !abstract || !revista || !autores) {
    return res.status(400).json({ error: 'Campos requeridos: titulo, abstract, revista, autores.' });
  }

  const cleanTitle = stripHtml(titulo);
  const cleanAbstract = stripHtml(abstract);
  const cleanRevista = stripHtml(revista);
  const cleanAutores = stripHtml(autores);
  const disc = stripHtml(String(disciplina || 'General'));
  const hl = Array.isArray(highlights) ? highlights.map(h => stripHtml(String(h))).filter(Boolean) : [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Error de configuración del servidor.' });

  const userMsg = `Título: ${cleanTitle}\nAbstract: ${cleanAbstract}\nRevista destino: ${cleanRevista}\nAutores: ${cleanAutores}\nDisciplina: ${disc}${hl.length ? `\nHighlights: ${hl.join('; ')}` : ''}`;

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
    if (!response.ok) return res.status(502).json({ error: 'Error al generar cover letter.' });

    const data = await response.json();
    const text = data?.content?.[0]?.text;
    if (!text) return res.status(502).json({ error: 'No se generó la carta.' });

    return res.status(200).json({ cover_letter: text.trim() });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Generación tardó demasiado.' });
    return res.status(500).json({ error: 'Error inesperado.' });
  }
}
