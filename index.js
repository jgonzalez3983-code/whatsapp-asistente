require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cron = require('node-cron');
const axios = require('axios');

const { CARPETAS, guardarItem, listarPendientes, marcarHecho } = require('./db');
const { clasificarMensaje } = require('./clasificador');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const MI_WHATSAPP = process.env.MI_WHATSAPP;

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

async function transcribirNotaDeVoz(mediaUrl) {
  const audioResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    }
  });

  const dgResponse = await axios.post(
    'https://api.deepgram.com/v1/listen?language=es&smart_format=true',
    audioResponse.data,
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/ogg'
      }
    }
  );

  const transcript = dgResponse.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return transcript.trim();
}

async function enviarWhatsApp(mensaje) {
  await client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: MI_WHATSAPP,
    body: mensaje
  });
}

app.post('/whatsapp', async (req, res) => {
  let textoOriginal = (req.body.Body || '').trim();
  console.log('MENSAJE RECIBIDO:', JSON.stringify(req.body));
  const respuesta = new twilio.twiml.MessagingResponse();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const tipoMedia = req.body.MediaContentType0 || '';

  try {
    if (numMedia > 0 && tipoMedia.startsWith('audio')) {
      textoOriginal = await transcribirNotaDeVoz(req.body.MediaUrl0);
      if (!textoOriginal) {
        respuesta.message('No pude entender la nota de voz, intenta de nuevo o escribe el mensaje.');
        res.type('text/xml').send(respuesta.toString());
        return;
      }
    }

    const textoLower = textoOriginal.toLowerCase();

    if (textoLower === 'lista' || textoLower === 'pendientes') {
      const items = listarPendientes();
      respuesta.message(formatearLista(items));

    } else if (textoLower.startsWith('lista ')) {
      const carpeta = textoLower.replace('lista ', '').trim();
      if (CARPETAS.includes(carpeta)) {
        const items = listarPendientes(carpeta);
        respuesta.message(formatearLista(items));
      } else {
        respuesta.message(`Carpeta no reconocida. Usa una de: ${CARPETAS.join(', ')}`);
      }

    } else if (textoLower.startsWith('hecho ')) {
      const id = parseInt(textoLower.replace('hecho ', '').trim(), 10);
      const ok = marcarHecho(id);
      respuesta.message(ok ? `✅ Marcado como hecho: #${id}` : `No encontré el item #${id}`);

    } else if (textoOriginal.length > 0) {
      const { carpeta, contenido } = await clasificarMensaje(textoOriginal);
      const id = guardarItem(carpeta, contenido);
      const prefijo = numMedia > 0 ? `🎙️ "${textoOriginal}"\n` : '';
      respuesta.message(`${prefijo}Guardado en ${NOMBRES_CARPETA[carpeta]} (#${id})`);
    }
  } catch (err) {
    console.error(err);
    respuesta.message('Ocurrió un error procesando tu mensaje.');
  }

  res.type('text/xml').send(respuesta.toString());
});

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
