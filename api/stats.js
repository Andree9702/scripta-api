// Vercel Serverless Function — Service Stats
// Endpoint: GET /api/stats

export default function handler(req, res) {
  res.status(200).json({
    service: 'scripta-api',
    endpoints: [
      { path: '/api/generate-sample', method: 'POST', description: 'Genera muestra académica' },
      { path: '/api/health', method: 'GET', description: 'Health check' },
      { path: '/api/stats', method: 'GET', description: 'Info del servicio' },
    ],
    model: 'claude-sonnet-4-20250514',
    rateLimit: '10 req/IP/hora',
    cors: 'scriptaacademic.com',
  });
}
