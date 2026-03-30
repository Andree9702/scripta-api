// Vercel Serverless Function — Virtual Committee (Thesis Defense Simulator)
// Endpoint: POST /api/virtual-committee
// Mode 1 (initial): Body: { titulo_tesis, abstract, disciplina, nivel }
//   → Response: { preguntas: [{rol, nombre, pregunta, enfoque}] }
// Mode 2 (response): Body: { titulo_tesis, abstract, disciplina, nivel, pregunta_estudiante, historial }
//   → Response: { evaluacion: {rol, nombre, calificacion, retroalimentacion, pregunta_seguimiento} }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 45000;

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const rateLimitMap = new Map();

const VALID_LEVELS = ['pregrado', 'maestria', 'doctorado'];

const SYSTEM_PROMPT_INITIAL = `Eres un simulador de tribunal de defensa de tesis del ecosistema EVOLUTION de Scripta Academic.

MISIÓN: Simular un tribunal académico realista con 5 miembros que hacen preguntas exigentes pero justas.

LOS 5 MIEMBROS DEL TRIBUNAL:

1. PRESIDENTE — Dr. Morales (Coherencia general)
   Evalúa: estructura lógica, hilo argumental, aporte al conocimiento
   Estilo: directo, busca la contribución central

2. METODÓLOGO — Dra. Vásquez (Diseño de investigación)
   Evalúa: diseño experimental, muestreo, validez interna/externa
   Estilo: técnica, precisa, busca debilidades metodológicas

3. ESTADÍSTICO — Dr. Restrepo (Análisis de datos)
   Evalúa: pruebas estadísticas, tamaños de muestra, interpretación
   Estilo: numérico, pide justificaciones de cada decisión estadística

4. EXPERTO DISCIPLINAR — Dra. Pacheco (Profundidad temática)
   Evalúa: dominio del tema, bibliografía, contexto disciplinar
   Estilo: profunda, conecta con literatura reciente

5. EVALUADOR EXTERNO — Dr. Torres (Supuestos no justificados)
   Evalúa: supuestos, generalizabilidad, implicaciones prácticas
   Estilo: escéptico constructivo, desafía lo que el estudiante da por hecho

REGLAS:
1. Cada miembro hace EXACTAMENTE 1 pregunta
2. Las preguntas deben ser específicas al manuscrito, NO genéricas
3. Nivel de dificultad según el grado: pregrado (fundamentación), maestría (análisis crítico), doctorado (frontera del conocimiento)
4. Las preguntas deben ser las que un tribunal REAL haría

FORMATO (JSON, sin backticks):
{
  "preguntas": [
    {"rol": "Presidente", "nombre": "Dr. Morales", "pregunta": "...", "enfoque": "coherencia general"},
    {"rol": "Metodólogo", "nombre": "Dra. Vásquez", "pregunta": "...", "enfoque": "diseño de investigación"},
    {"rol": "Estadístico", "nombre": "Dr. Restrepo", "pregunta": "...", "enfoque": "análisis de datos"},
    {"rol": "Experto disciplinar", "nombre": "Dra. Pacheco", "pregunta": "...", "enfoque": "profundidad temática"},
    {"rol": "Evaluador externo", "nombre": "Dr. Torres", "pregunta": "...", "enfoque": "supuestos y generalizabilidad"}
  ]
}`;

function buildResponsePrompt(historial) {
  const lastQuestion = historial?.[historial.length - 1] || {};
  const memberName = lastQuestion.rol || 'un miembro del tribunal';

  return `Eres ${memberName} del tribunal de defensa de tesis. El estudiante acaba de responder tu pregunta.

EVALÚA la respuesta del estudiante:
1. ¿Respondió la pregunta directamente?
2. ¿Demostró dominio del tema?
3. ¿Fue preciso o divagó?

FORMATO (JSON, sin backticks):
{
  "evaluacion": {
    "rol": "${lastQuestion.rol || ''}",
    "nombre": "${memberName}",
    "calificacion": "excelente|buena|aceptable|insuficiente",
    "retroalimentacion": "2-3 oraciones de feedback constructivo",
    "pregunta_seguimiento": "Una pregunta de profundización basada en la respuesta (o null si la respuesta fue excelente)"
  }
}`;
}

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
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Límite de sesiones alcanzado por hoy.' });

  const { titulo_tesis, abstract, disciplina, nivel, pregunta_estudiante, historial } = req.body || {};

  if (!titulo_tesis || stripHtml(titulo_tesis).length < 10)
    return res.status(400).json({ error: 'Título de tesis mínimo 10 caracteres.' });
  if (!abstract || stripHtml(abstract).length < 100)
    return res.status(400).json({ error: 'Abstract mínimo 100 caracteres.' });

  const cleanTitle = stripHtml(titulo_tesis);
  const cleanAbstract = stripHtml(abstract);
  const disc = stripHtml(String(disciplina || 'General'));
  const lvl = VALID_LEVELS.includes(nivel) ? nivel : 'maestria';
  const isResponseMode = !!pregunta_estudiante;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Error de configuración del servidor.' });

  let systemPrompt, userMsg;

  if (!isResponseMode) {
    // MODE 1: Generate 5 questions
    systemPrompt = SYSTEM_PROMPT_INITIAL;
    userMsg = `Nivel: ${lvl}\nTítulo: ${cleanTitle}\nAbstract: ${cleanAbstract}\nDisciplina: ${disc}`;
  } else {
    // MODE 2: Evaluate student response
    systemPrompt = buildResponsePrompt(historial);
    const hist = Array.isArray(historial) ? historial : [];
    const histContext = hist.map(h => `${h.rol || 'Tribunal'}: ${h.texto}`).join('\n');
    userMsg = `Tesis: ${cleanTitle}\nAbstract: ${cleanAbstract}\nDisciplina: ${disc}\nNivel: ${lvl}\n\nHistorial:\n${histContext}\n\nRespuesta del estudiante:\n${stripHtml(pregunta_estudiante)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return res.status(502).json({ error: 'Error al generar respuesta del tribunal.' });

    const data = await response.json();
    const raw = data?.content?.[0]?.text;
    if (!raw) return res.status(502).json({ error: 'No se recibió respuesta del tribunal.' });

    try {
      const parsed = tryParseJSON(raw);
      return res.status(200).json(parsed);
    } catch {
      return res.status(502).json({ error: 'Formato de respuesta inválido. Intenta de nuevo.' });
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'La sesión tardó demasiado.' });
    return res.status(500).json({ error: 'Error inesperado.' });
  }
}
