# scripta-api

API serverless para Scripta Academic. Genera muestras de texto academico usando Claude.

## Endpoint

```
POST /api/generate-sample
```

### Request body

```json
{
  "tema": "Impacto del cambio climatico en la biodiversidad marina",
  "disciplina": "Ciencias ambientales",
  "tipo": "Introduccion"
}
```

### Response

```json
{
  "texto": "El parrafo academico generado..."
}
```

### Errores

| Status | Significado |
|--------|-------------|
| 400 | Input invalido (tema muy corto/largo) |
| 405 | Metodo no permitido (solo POST) |
| 429 | Rate limited (max 10/hora por IP) |
| 502 | Error de la API de Anthropic |
| 504 | Timeout (>30s) |

## Setup

### 1. Variables de entorno

En Vercel Dashboard > Settings > Environment Variables:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Deploy

**Opcion A — Vercel CLI:**

```bash
npm install -g vercel
vercel login
vercel --prod
```

**Opcion B — GitHub:**

Conectar este repo a Vercel Dashboard. Deploy automatico con cada push.

### 3. Testear localmente

```bash
npm install -g vercel
vercel dev
```

Luego: `curl -X POST http://localhost:3000/api/generate-sample -H "Content-Type: application/json" -d '{"tema":"Fotosintesis en plantas C4","disciplina":"Ciencias agropecuarias","tipo":"Marco teorico"}'`

## CORS

El archivo `vercel.json` configura CORS. Actualmente esta en `"*"` para desarrollo.

**Para produccion**, cambiar a:

```json
{ "key": "Access-Control-Allow-Origin", "value": "https://scriptaacademic.com" }
```

## Costos estimados

- ~$0.0075 por muestra generada
- 100 muestras/dia = ~$22.50/mes
- Vercel free tier: 100K invocaciones/mes
