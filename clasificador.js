const Anthropic = require('@anthropic-ai/sdk');
const { CARPETAS } = require('./db');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Clasifica un mensaje libre en una de las carpetas y limpia el texto
async function clasificarMensaje(texto) {
  const prompt = `Eres un clasificador de notas personales. Dado el siguiente mensaje de WhatsApp, decide a cuál de estas carpetas pertenece:

- ideas
- recordatorios
- reuniones
- llamadas
- reparaciones_urgentes (arreglos en casa que no pueden esperar)
- reparaciones_generales (arreglos en casa sin urgencia)
- vehiculo (mantenciones o reparaciones del auto)

Mensaje: "${texto}"

Responde SOLO con un JSON válido, sin texto adicional, sin markdown, con este formato exacto:
{"carpeta": "una_de_las_opciones", "contenido": "el texto reformulado de forma breve y clara"}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
  const limpio = raw.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(limpio);
    if (!CARPETAS.includes(parsed.carpeta)) parsed.carpeta = 'ideas';
    return parsed;
  } catch (e) {
    return { carpeta: 'ideas', contenido: texto };
  }
}

module.exports = { clasificarMensaje };
