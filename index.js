require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const {
  listarCarpetas, crearCarpeta, editarCarpeta, eliminarCarpeta,
  guardarItem, listarPendientes, listarTodos,
  marcarHecho, alternarHecho, eliminarItem, getConfig, setConfig, rodarPendientesVencidos
} = require('./db');
const { clasificarMensaje } = require('./clasificador');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'mi-asistente-verificacion';
const MI_WHATSAPP = process.env.MI_WHATSAPP;
const GRAPH_URL = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

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

async function transcribirNotaDeVoz(mediaId) {
  const infoMedia = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
  });
  const urlAudio = infoMedia.data.url;

  const audioResponse = await axios.get(urlAudio, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
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

async function enviarWhatsApp(mensaje, destinatario = MI_WHATSAPP) {
  await axios.post(GRAPH_URL, {
    messaging_product: 'whatsapp',
    to: destinatario,
    type: 'text',
    text: { body: mensaje }
  }, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

app.get('/whatsapp', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const desafio = req.query['hub.challenge'];

  if (modo === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente');
    res.status(200).send(desafio);
  } else {
    res.sendStatus(403);
  }
});

app.post('/whatsapp', async (req, res) => {
  res.sendStatus(200);

  try {
    const entrada = req.body.entry?.[0];
    const cambio = entrada?.changes?.[0];
    const mensaje = cambio?.value?.messages?.[0];
    if (!mensaje) return;

    const remitente = mensaje.from;
    let textoOriginal = '';
    let esNotaDeVoz = false;

    if (mensaje.type === 'text') {
      textoOriginal = (mensaje.text?.body || '').trim();
    } else if (mensaje.type === 'audio') {
      esNotaDeVoz = true;
      textoOriginal = await transcribirNotaDeVoz(mensaje.audio.id);
      if (!textoOriginal) {
        await enviarWhatsApp('No pude entender la nota de voz, intenta de nuevo o escribe el mensaje.', remitente);
        return;
      }
    } else {
      return;
    }

    const textoLower = textoOriginal.toLowerCase();
    const carpetasActuales = listarCarpetas();
    const clavesValidas = carpetasActuales.map(c => c.clave);
    let respuesta = '';

    if (textoLower === 'lista' || textoLower === 'pendientes') {
      const items = listarPendientes();
      respuesta = formatearLista(items);

    } else if (textoLower.startsWith('lista ')) {
      const carpeta = textoLower.replace('lista ', '').trim();
      if (clavesValidas.includes(carpeta)) {
        const items = listarPendientes(carpeta);
        respuesta = formatearLista(items);
      } else {
        respuesta = `Carpeta no reconocida. Usa una de: ${clavesValidas.join(', ')}`;
      }

    } else if (textoLower.startsWith('hecho ')) {
      const id = parseInt(textoLower.replace('hecho ', '').trim(), 10);
      const ok = marcarHecho(id);
      respuesta = ok ? `✅ Marcado como hecho: #${id}` : `No encontré el item #${id}`;

    } else if (textoLower.startsWith('crear carpeta ') || textoLower.startsWith('nueva carpeta ') || textoLower.startsWith('créame la carpeta ') || textoLower.startsWith('creame la carpeta ')) {
      const nombre = textoOriginal.replace(/^(crear carpeta|nueva carpeta|créame la carpeta|creame la carpeta)\s*/i, '').trim();
      if (nombre) {
        crearCarpeta(nombre);
        respuesta = `📁 Carpeta creada: "${nombre}". Ya puedes guardar cosas ahí mencionando su nombre.`;
      } else {
        respuesta = 'Dime el nombre así: "crear carpeta jardín"';
      }

    } else if (textoOriginal.length > 0) {
      const { carpeta, contenido } = await clasificarMensaje(textoOriginal);
      const id = guardarItem(carpeta, contenido);
      const prefijo = esNotaDeVoz ? `🎙️ "${textoOriginal}"\n` : '';
      respuesta = `${prefijo}Guardado en ${nombreConEmoji(carpeta)} (#${id})`;
    }

    if (respuesta) await enviarWhatsApp(respuesta, remitente);
  } catch (err) {
    console.error('ERROR procesando mensaje de WhatsApp:', err.response?.data || err.message);
  }
});

app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
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

app.post('/api/items', requiereContrasena, (req, res) => {
  const { carpeta, contenido, fecha } = req.body;
  if (!carpeta || !contenido || !contenido.trim()) {
    return res.status(400).json({ ok: false, error: 'Falta carpeta o contenido' });
  }
  const fechaCompleta = fecha ? `${fecha} 12:00:00` : null;
  const id = guardarItem(carpeta, contenido.trim(), fechaCompleta);
  res.json({ ok: true, id });
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

app.patch('/api/carpetas/:clave', requiereContrasena, (req, res) => {
  const { nombre, emoji } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ ok: false, error: 'Falta el nombre' });
  const ok = editarCarpeta(req.params.clave, nombre.trim(), emoji || '📁');
  res.json({ ok });
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

function fechaDeHoyChile() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

cron.schedule('5 0 * * *', () => {
  const movidos = rodarPendientesVencidos(fechaDeHoyChile());
  if (movidos > 0) console.log(`${movidos} pendiente(s) vencido(s) movidos a hoy`);
}, { timezone: 'America/Santiago' });

rodarPendientesVencidos(fechaDeHoyChile());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
