require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cron = require('node-cron');

const { CARPETAS, guardarItem, listarPendientes, marcarHecho } = require('./db');
const { clasificarMensaje } = require('./clasificador');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // ej: whatsapp:+14155238886
const MI_WHATSAPP = process.env.MI_WHATSAPP; // ej: whatsapp:+56912345678

const NOMBRES_CARPETA = {
  ideas: '💡 Ideas',
  recordatorios: '⏰ Recordatorios',
  reuniones: '📅 Reuniones',
  llamadas: '📞 Llamadas',
  reparaciones_urgentes: '🚨 Reparaciones urgentes',
  reparaciones_generales: '🔧 Reparaciones generales',
  vehiculo: '🚗 Vehículo'
};

function formatearLista(items) {
  if (items.length === 0) return 'No tienes pendientes. 🎉';
  const porCarpeta = {};
  for (const item of items) {
    if (!porCarpeta[item.carpeta]) porCarpeta[item.carpeta] = [];
    porCarpeta[item.carpeta].push(item);
  }
  let texto = '';
  for (const carpeta of CARPETAS) {
    if (!porCarpeta[carpeta]) continue;
    texto += `\n${NOMBRES_CARPETA[carpeta]}\n`;
    for (const item of porCarpeta[carpeta]) {
      texto += `  #${item.id} ${item.contenido}\n`;
    }
  }
  return texto.trim();
}

async function enviarWhatsApp(mensaje) {
  await client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: MI_WHATSAPP,
    body: mensaje
  });
}

// Webhook: recibe mensajes desde WhatsApp
app.post('/whatsapp', async (req, res) => {
  const textoOriginal = (req.body.Body || '').trim();
  const respuesta = new twilio.twiml.MessagingResponse();

  try {
    const textoLower = textoOriginal.toLowerCase();

    // Comando: ver lista completa
    if (textoLower === 'lista' || textoLower === 'pendientes') {
      const items = listarPendientes();
      respuesta.message(formatearLista(items));

    // Comando: ver una carpeta específica -> "lista ideas"
    } else if (textoLower.startsWith('lista ')) {
      const carpeta = textoLower.replace('lista ', '').trim();
      if (CARPETAS.includes(carpeta)) {
        const items = listarPendientes(carpeta);
        respuesta.message(formatearLista(items));
      } else {
        respuesta.message(`Carpeta no reconocida. Usa una de: ${CARPETAS.join(', ')}`);
      }

    // Comando: marcar como hecho -> "hecho 5"
    } else if (textoLower.startsWith('hecho ')) {
      const id = parseInt(textoLower.replace('hecho ', '').trim(), 10);
      const ok = marcarHecho(id);
      respuesta.message(ok ? `✅ Marcado como hecho: #${id}` : `No encontré el item #${id}`);

    // Cualquier otro mensaje: clasificar y guardar
    } else if (textoOriginal.length > 0) {
      const { carpeta, contenido } = await clasificarMensaje(textoOriginal);
      const id = guardarItem(carpeta, contenido);
      respuesta.message(`Guardado en ${NOMBRES_CARPETA[carpeta]} (#${id})`);
    }
  } catch (err) {
    console.error(err);
    respuesta.message('Ocurrió un error procesando tu mensaje.');
  }

  res.type('text/xml').send(respuesta.toString());
});

// Recordatorios automáticos: 8:00 AM y 3:30 PM (hora de Santiago)
cron.schedule('0 8 * * *', async () => {
  const items = listarPendientes();
  await enviarWhatsApp(`☀️ Buenos días. Tus pendientes:\n\n${formatearLista(items)}`);
}, { timezone: 'America/Santiago' });

cron.schedule('30 15 * * *', async () => {
  const items = listarPendientes();
  await enviarWhatsApp(`🕒 Recordatorio de media tarde:\n\n${formatearLista(items)}`);
}, { timezone: 'America/Santiago' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
