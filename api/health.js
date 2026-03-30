// Vercel Serverless Function — Health Check
// Endpoint: GET /api/health

export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'scripta-api',
    version: '1.1.0',
    timestamp: new Date().toISOString(),
  });
}
