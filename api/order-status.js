// Vercel Serverless Function — Scripta Academic Order Status Tracker
// Endpoint: GET /api/order-status?code=SC-XXXX
// Response: { code, client_name, service, current_status, status_info, all_steps, ... }

// ─── Orders database (MVP: edit here, push to deploy) ──────────────────────────
// Andreé: add real orders below. Format: "SC-XXXX": { ... }
// When volume grows, migrate to Vercel KV or a database.

const orders = {
  // ── Example (remove or keep as test) ─────────────────────────────────────────
  "SC-TEST": {
    client_name: "Dr. Test",
    service: "Paquete Paper a Publicación",
    status: 1,  // 0=recibido, 1=produccion, 2=revision, 3=listo
    created_at: "2026-03-30",
    updated_at: "2026-03-30",
  },
  // ── Real orders go below this line ───────────────────────────────────────────
};

// ─── Status definitions ────────────────────────────────────────────────────────

const STATUS_STEPS = [
  {
    label: "Recibido",
    description: "Tu manuscrito fue recibido. Estamos preparando el diagnóstico inicial.",
    icon: "clipboard",
  },
  {
    label: "En producción",
    description: "Nuestro equipo está trabajando en tu manuscrito.",
    icon: "gear",
  },
  {
    label: "En revisión experta",
    description: "Tu manuscrito está siendo revisado por nuestro experto.",
    icon: "search",
  },
  {
    label: "Listo para entrega",
    description: "¡Tu manuscrito está listo! Revisa tu email.",
    icon: "check",
  },
];

// ─── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://scriptaacademic.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const CODE_REGEX = /^SC-[A-Z0-9]{3,6}$/;

function maskName(name) {
  if (!name) return '';
  const parts = name.split(' ');
  return parts.map((p, i) => {
    if (i === 0) return p; // Keep title or first name
    if (p.length <= 2) return p;
    return p[0] + '*'.repeat(p.length - 1);
  }).join(' ');
}

// ─── Handler ───────────────────────────────────────────────────────────────────

export default function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const code = (req.query.code || '').toUpperCase().trim();

  if (!code) {
    return res.status(400).json({ error: 'El código de seguimiento es requerido. Formato: SC-XXXX' });
  }

  if (!CODE_REGEX.test(code)) {
    return res.status(400).json({ error: 'Formato inválido. El código debe ser SC- seguido de 3-6 caracteres alfanuméricos.' });
  }

  const order = orders[code];

  if (!order) {
    return res.status(404).json({
      error: 'Código de seguimiento no encontrado. Verifica que esté correcto.',
    });
  }

  const statusIndex = Math.min(Math.max(order.status || 0, 0), STATUS_STEPS.length - 1);

  return res.status(200).json({
    code,
    client_name: maskName(order.client_name),
    service: order.service,
    current_status: statusIndex,
    status_info: STATUS_STEPS[statusIndex],
    all_steps: STATUS_STEPS,
    created_at: order.created_at,
    updated_at: order.updated_at,
  });
}
