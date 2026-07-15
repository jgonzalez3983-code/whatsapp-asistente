require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const {
  listarCarpetas, crearCarpeta, eliminarCarpeta,
  guardarItem, listarPendientes, listarTodos,
  marcarHecho, alternarHecho, eliminarItem, getConfig, setConfig
} = require('./db');
const { clasificarMensaje } = require('./clasificador');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const MI_WHATSAPP = process.env.MI_WHATSAPP;

function nombreConEmoji(carpetaClave) {
  const carpetas = listarCarpetas();
  const c = carpetas.find(c => c.clave === carpetaClave);
  return c ? `${c.emoji} ${c.nombre}` : carpetaClave;
}

function formatearLista(items) {
  if (items.length === 0) return 'No tienes pendientes. 🎉';
  const carpetas = listarCarpetas();
  const porCarpeta = {};
  for (const item of items) {
    if (!porCarpeta[item.carpeta]) porCarpeta[item.carpeta] = [];
    porCarpeta[item.carpeta].push(item);
  }
  let texto = '';
  for (const carpeta of carpetas) {
    if (!porCarpeta[carpeta.clave]) continue;
    texto += `\n${carpeta.emoji} ${carpeta.nombre}\n`;
    for (const item of porCarpeta[carpeta.clave]) {
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
    const carpetasActuales = listarCarpetas();
    const clavesValidas = carpetasActuales.map(c => c.clave);

    if (textoLower === 'lista' || textoLower === 'pendientes') {
      const items = listarPendientes();
      respuesta.message(formatearLista(items));

    } else if (textoLower.startsWith('lista ')) {
      const carpeta = textoLower.replace('lista ', '').trim();
      if (clavesValidas.includes(carpeta)) {
        const items = listarPendientes(carpeta);
        respuesta.message(formatearLista(items));
      } else {
        respuesta.message(`Carpeta no reconocida. Usa una de: ${clavesValidas.join(', ')}`);
      }

    } else if (textoLower.startsWith('hecho ')) {
      const id = parseInt(textoLower.replace('hecho ', '').trim(), 10);
      const ok = marcarHecho(id);
      respuesta.message(ok ? `✅ Marcado como hecho: #${id}` : `No encontré el item #${id}`);

    } else if (textoLower.startsWith('crear carpeta ') || textoLower.startsWith('nueva carpeta ') || textoLower.startsWith('créame la carpeta ') || textoLower.startsWith('creame la carpeta ')) {
      const nombre = textoOriginal.replace(/^(crear carpeta|nueva carpeta|créame la carpeta|creame la carpeta)\s*/i, '').trim();
      if (nombre) {
        const clave = crearCarpeta(nombre);
        respuesta.message(`📁 Carpeta creada: "${nombre}". Ya puedes guardar cosas ahí mencionando su nombre.`);
      } else {
        respuesta.message('Dime el nombre así: "crear carpeta jardín"');
      }

    } else if (textoOriginal.length > 0) {
      const { carpeta, contenido } = await clasificarMensaje(textoOriginal);
      const id = guardarItem(carpeta, contenido);
      const prefijo = numMedia > 0 ? `🎙️ "${textoOriginal}"\n` : '';
      respuesta.message(`${prefijo}Guardado en ${nombreConEmoji(carpeta)} (#${id})`);
    }
  } catch (err) {
    console.error('ERROR:', err);
    respuesta.message('Ocurrió un error procesando tu mensaje.');
  }

  res.type('text/xml').send(respuesta.toString());
});

function requiereContrasena(req, res, next) {
  const auth = { login: 'admin', password: process.env.DASHBOARD_PASSWORD || 'cambiame' };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login === auth.login && password === auth.password) return next();
  res.set('WWW-Authenticate', 'Basic realm="Mi Asistente"');
  res.status(401).send('Acceso restringido.');
}

app.use('/dashboard', requiereContrasena, express.static(path.join(__dirname, 'public')));
app.get('/dashboard', requiereContrasena, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/items', requiereContrasena, (req, res) => {
  res.json(listarTodos());
});

app.post('/api/items/:id/toggle', requiereContrasena, (req, res) => {
  const nuevoEstado = alternarHecho(req.params.id);
  res.json({ ok: nuevoEstado !== null, hecho: nuevoEstado });
});

app.delete('/api/items/:id', requiereContrasena, (req, res) => {
  const ok = eliminarItem(req.params.id);
  res.json({ ok });
});

app.get('/api/carpetas', requiereContrasena, (req, res) => {
  res.json(listarCarpetas());
});

app.post('/api/carpetas', requiereContrasena, (req, res) => {
  const { nombre, emoji } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ ok: false, error: 'Falta el nombre' });
  const clave = crearCarpeta(nombre.trim(), emoji || '📁');
  res.json({ ok: true, clave });
});

app.delete('/api/carpetas/:clave', requiereContrasena, (req, res) => {
  const ok = eliminarCarpeta(req.params.clave);
  res.json({ ok });
});

app.get('/api/config', requiereContrasena, (req, res) => {
  res.json({
    hora_manana: getConfig('hora_manana', '08:00'),
    hora_tarde: getConfig('hora_tarde', '15:30'),
    recordatorios_activos: getConfig('recordatorios_activos', 'true')
  });
});

app.post('/api/config', requiereContrasena, (req, res) => {
  const { hora_manana, hora_tarde, recordatorios_activos } = req.body;
  if (hora_manana) setConfig('hora_manana', hora_manana);
  if (hora_tarde) setConfig('hora_tarde', hora_tarde);
  setConfig('recordatorios_activos', recordatorios_activos ? 'true' : 'false');
  reprogramarRecordatorios();
  res.json({ ok: true });
});

let tareaManana = null;
let tareaTarde = null;

function reprogramarRecordatorios() {
  if (tareaManana) tareaManana.stop();
  if (tareaTarde) tareaTarde.stop();

  const activos = getConfig('recordatorios_activos', 'true') === 'true';
  if (!activos) return;

  const [hM, mM] = getConfig('hora_manana', '08:00').split(':');
  const [hT, mT] = getConfig('hora_tarde', '15:30').split(':');

  tareaManana = cron.schedule(`${mM} ${hM} * * *`, async () => {
    const items = listarPendientes();
    await enviarWhatsApp(`☀️ Buenos días. Tus pendientes:\n\n${formatearLista(items)}`);
  }, { timezone: 'America/Santiago' });

  tareaTarde = cron.schedule(`${mT} ${hT} * * *`, async () => {
    const items = listarPendientes();
    await enviarWhatsApp(`🕒 Recordatorio de media tarde:\n\n${formatearLista(items)}`);
  }, { timezone: 'America/Santiago' });
}

reprogramarRecordatorios();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
