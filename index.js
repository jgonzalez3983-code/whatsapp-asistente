require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const {
  listarCarpetas, crearCarpeta, editarCarpeta, eliminarCarpeta,
  guardarItem, listarPendientes, listarTodos, listarUsuarios,
  marcarHecho, alternarHecho, eliminarItem, getConfig, setConfig, rodarPendientesVencidos
} = require('./db');
const { clasificarMensaje } = require('./clasificador');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ============ CONFIGURACIÓN DE META (WhatsApp Cloud API) ============
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'mi-asistente-verificacion';
const MI_WHATSAPP = process.env.MI_WHATSAPP; // formato: 56912345678 (sin + ni espacios)
const GRAPH_URL = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

// Reconoce un número ya sea en dígitos ("3") o dictado por voz ("tres")
function numeroDesdeTexto(texto) {
  const matchDigito = texto.match(/\d+/);
  if (matchDigito) return parseInt(matchDigito[0], 10);

  const PALABRAS = {
    uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
    ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
    quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20
  };
  const textoNorm = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const palabra of Object.keys(PALABRAS)) {
    if (new RegExp(`\\b${palabra}\\b`).test(textoNorm)) return PALABRAS[palabra];
  }
  return null;
}

// Reconoce TODOS los números mencionados en un mensaje (para borrar/marcar varias tareas de una vez)
function numerosDesdeTexto(texto) {
  const PALABRAS = {
    uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
    ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
    quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20
  };
  const textoNorm = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const encontrados = [];
  const tokens = textoNorm.split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      encontrados.push(parseInt(token, 10));
    } else if (PALABRAS[token] !== undefined) {
      encontrados.push(PALABRAS[token]);
    }
  }
  return [...new Set(encontrados)];
}

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
    texto += `\n${carpeta.emoji} *${carpeta.nombre.toUpperCase()}*\n`;
    for (const item of porCarpeta[carpeta.clave]) {
      texto += `  #${item.id} ${item.contenido}\n`;
    }
  }
  return texto.trim();
}

// Descarga y transcribe una nota de voz usando la API de Meta + Deepgram
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

// Envía un mensaje de texto por WhatsApp usando la API de Meta
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

// ============ VERIFICACIÓN DEL WEBHOOK (Meta la pide al configurar) ============
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

// ============ WEBHOOK DE WHATSAPP (mensajes entrantes) ============
app.post('/whatsapp', async (req, res) => {
  // Siempre respondemos 200 rápido, Meta no espera una respuesta con contenido
  res.sendStatus(200);

  try {
    const entrada = req.body.entry?.[0];
    const cambio = entrada?.changes?.[0];
    const mensaje = cambio?.value?.messages?.[0];
    if (!mensaje) return; // puede ser una notificación de "leído", la ignoramos

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
      return; // tipo de mensaje no soportado (imagen, sticker, etc.)
    }

    const textoLower = textoOriginal.toLowerCase().trim().replace(/[.,!?¡¿;:]+$/g, '').trim();
    const carpetasActuales = listarCarpetas();
    const clavesValidas = carpetasActuales.map(c => c.clave);
    let respuesta = '';

    if (textoLower === 'lista' || textoLower === 'pendientes') {
      const items = listarPendientes(remitente);
      respuesta = formatearLista(items);

    } else if (textoLower.startsWith('lista ')) {
      const carpeta = textoLower.replace('lista ', '').trim();
      if (clavesValidas.includes(carpeta)) {
        const items = listarPendientes(remitente, carpeta);
        respuesta = formatearLista(items);
      } else {
        respuesta = `Carpeta no reconocida. Usa una de: ${clavesValidas.join(', ')}`;
      }

    } else if (textoLower.startsWith('hecho ')) {
      const id = parseInt(textoLower.replace('hecho ', '').trim(), 10);
      const ok = marcarHecho(id);
      respuesta = ok ? `✅ Marcado como hecho: #${id}` : `No encontré el item #${id}`;

    } else if (/\b(borra|borrar|elimina|eliminar|quita|quitar)\b/.test(textoLower) && numerosDesdeTexto(textoLower).length > 0) {
      const ids = numerosDesdeTexto(textoLower);
      const borrados = ids.filter(id => eliminarItem(id));
      const noEncontrados = ids.filter(id => !borrados.includes(id));
      let msg = borrados.length > 0 ? `🗑️ Eliminado(s): ${borrados.map(i => '#' + i).join(', ')}` : '';
      if (noEncontrados.length > 0) msg += `${msg ? '\n' : ''}No encontré: ${noEncontrados.map(i => '#' + i).join(', ')}`;
      respuesta = msg || 'No encontré esos items.';

    } else if (/\b(lista|listo|hecha|hecho|terminada|terminado|completa|completo|list[oa]?)\b/.test(textoLower) && numerosDesdeTexto(textoLower).length > 0) {
      const ids = numerosDesdeTexto(textoLower);
      const marcados = ids.filter(id => marcarHecho(id));
      const noEncontrados = ids.filter(id => !marcados.includes(id));
      let msg = marcados.length > 0 ? `✅ Marcado(s) como hecho: ${marcados.map(i => '#' + i).join(', ')}` : '';
      if (noEncontrados.length > 0) msg += `${msg ? '\n' : ''}No encontré: ${noEncontrados.map(i => '#' + i).join(', ')}`;
      respuesta = msg || 'No encontré esos items.';

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
      const id = guardarItem(carpeta, contenido, remitente);
      const prefijo = esNotaDeVoz ? `🎙️ "${textoOriginal}"\n` : '';
      respuesta = `${prefijo}Guardado en ${nombreConEmoji(carpeta)} (#${id})`;
    }

    if (respuesta) await enviarWhatsApp(respuesta, remitente);
  } catch (err) {
    console.error('ERROR procesando mensaje de WhatsApp:', err.response?.data || err.message);
  }
});

// ============ PÁGINA PÚBLICA DE POLÍTICA DE PRIVACIDAD (requerida por Meta) ============
app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

// ============ DASHBOARD (protegido con contraseña) ============
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
  res.json(listarTodos(req.query.usuario || null));
});

app.get('/api/usuarios', requiereContrasena, (req, res) => {
  res.json(listarUsuarios());
});

app.post('/api/items', requiereContrasena, (req, res) => {
  const { carpeta, contenido, fecha, usuario } = req.body;
  if (!carpeta || !contenido || !contenido.trim()) {
    return res.status(400).json({ ok: false, error: 'Falta carpeta o contenido' });
  }
  const fechaCompleta = fecha ? `${fecha} 12:00:00` : null;
  const id = guardarItem(carpeta, contenido.trim(), usuario || MI_WHATSAPP, fechaCompleta);
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

// ============ RECORDATORIOS AUTOMÁTICOS ============
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
    for (const usuario of listarUsuarios()) {
      const items = listarPendientes(usuario);
      if (items.length > 0) {
        try {
          await enviarWhatsApp(`☀️ Buenos días. Tus pendientes:\n\n${formatearLista(items)}`, usuario);
        } catch (err) {
          console.error(`Error mandando recordatorio de mañana a ${usuario}:`, err.response?.data || err.message);
        }
      }
    }
  }, { timezone: 'America/Santiago' });

  tareaTarde = cron.schedule(`${mT} ${hT} * * *`, async () => {
    for (const usuario of listarUsuarios()) {
      const items = listarPendientes(usuario);
      if (items.length > 0) {
        try {
          await enviarWhatsApp(`🕒 Recordatorio de media tarde:\n\n${formatearLista(items)}`, usuario);
        } catch (err) {
          console.error(`Error mandando recordatorio de tarde a ${usuario}:`, err.response?.data || err.message);
        }
      }
    }
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
