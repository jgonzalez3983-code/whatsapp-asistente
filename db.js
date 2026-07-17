const Database = require('better-sqlite3');
const path = require('path');

// Si existe un volumen persistente montado en /data (Railway), la base de datos se guarda ahí
// para que no se pierda entre despliegues. Si no existe, usa la carpeta del proyecto (para desarrollo local).
const fs = require('fs');
const carpetaDatos = fs.existsSync('/data') ? '/data' : __dirname;
const db = new Database(path.join(carpetaDatos, 'datos.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpeta TEXT NOT NULL,
    contenido TEXT NOT NULL,
    hecho INTEGER DEFAULT 0,
    usuario TEXT,
    creado_en TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migración: si la tabla ya existía de antes (sin la columna "usuario"), la agrega sin borrar nada
try {
  db.exec('ALTER TABLE items ADD COLUMN usuario TEXT');
} catch (e) {
  // ya existía la columna, no hay que hacer nada
}

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS carpetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clave TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    emoji TEXT DEFAULT '📁',
    orden INTEGER DEFAULT 0
  )
`);

// Carpetas por defecto, solo se insertan la primera vez
const CARPETAS_POR_DEFECTO = [
  { clave: 'ideas', nombre: 'Ideas', emoji: '💡' },
  { clave: 'recordatorios', nombre: 'Recordatorios', emoji: '⏰' },
  { clave: 'reuniones', nombre: 'Reuniones', emoji: '📅' },
  { clave: 'llamadas', nombre: 'Llamadas', emoji: '📞' },
  { clave: 'reparaciones_urgentes', nombre: 'Reparaciones urgentes', emoji: '🚨' },
  { clave: 'reparaciones_generales', nombre: 'Reparaciones generales', emoji: '🔧' },
  { clave: 'vehiculo', nombre: 'Vehículo', emoji: '🚗' }
];

const yaHayCarpetas = db.prepare('SELECT COUNT(*) AS n FROM carpetas').get().n > 0;
if (!yaHayCarpetas) {
  const insertar = db.prepare('INSERT INTO carpetas (clave, nombre, emoji, orden) VALUES (?, ?, ?, ?)');
  CARPETAS_POR_DEFECTO.forEach((c, i) => insertar.run(c.clave, c.nombre, c.emoji, i));
}

function normalizarClave(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function listarCarpetas() {
  return db.prepare('SELECT * FROM carpetas ORDER BY orden, id').all();
}

function crearCarpeta(nombre, emoji = '📁') {
  let clave = normalizarClave(nombre);
  if (!clave) clave = 'carpeta';
  // evita duplicados agregando un número al final
  let claveFinal = clave;
  let intento = 1;
  while (db.prepare('SELECT 1 FROM carpetas WHERE clave = ?').get(claveFinal)) {
    intento++;
    claveFinal = `${clave}_${intento}`;
  }
  const maxOrden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS m FROM carpetas').get().m;
  db.prepare('INSERT INTO carpetas (clave, nombre, emoji, orden) VALUES (?, ?, ?, ?)')
    .run(claveFinal, nombre, emoji, maxOrden + 1);
  return claveFinal;
}

function editarCarpeta(clave, nombre, emoji) {
  const info = db.prepare('UPDATE carpetas SET nombre = ?, emoji = ? WHERE clave = ?').run(nombre, emoji, clave);
  return info.changes > 0;
}

function eliminarCarpeta(clave) {
  const info = db.prepare('DELETE FROM carpetas WHERE clave = ?').run(clave);
  return info.changes > 0;
}

function guardarItem(carpeta, contenido, usuario, fecha = null) {
  if (fecha) {
    const stmt = db.prepare('INSERT INTO items (carpeta, contenido, usuario, creado_en) VALUES (?, ?, ?, ?)');
    const info = stmt.run(carpeta, contenido, usuario, fecha);
    return info.lastInsertRowid;
  }
  const stmt = db.prepare('INSERT INTO items (carpeta, contenido, usuario) VALUES (?, ?, ?)');
  const info = stmt.run(carpeta, contenido, usuario);
  return info.lastInsertRowid;
}

function listarPendientes(usuario, carpeta = null) {
  if (carpeta) {
    return db.prepare('SELECT * FROM items WHERE hecho = 0 AND usuario = ? AND carpeta = ? ORDER BY id').all(usuario, carpeta);
  }
  return db.prepare('SELECT * FROM items WHERE hecho = 0 AND usuario = ? ORDER BY carpeta, id').all(usuario);
}

// Para el dashboard: si no se pasa usuario, trae todo (vista de administrador)
function listarTodos(usuario = null) {
  if (usuario) {
    return db.prepare('SELECT * FROM items WHERE usuario = ? ORDER BY hecho ASC, carpeta, id DESC').all(usuario);
  }
  return db.prepare('SELECT * FROM items ORDER BY hecho ASC, carpeta, id DESC').all();
}

function listarUsuarios() {
  return db.prepare("SELECT DISTINCT usuario FROM items WHERE usuario IS NOT NULL AND trim(usuario) != '' ORDER BY usuario").all().map(r => r.usuario);
}

function marcarHecho(id) {
  const stmt = db.prepare('UPDATE items SET hecho = 1 WHERE id = ?');
  const info = stmt.run(id);
  return info.changes > 0;
}

function alternarHecho(id) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) return null;
  const nuevoEstado = item.hecho ? 0 : 1;
  db.prepare('UPDATE items SET hecho = ? WHERE id = ?').run(nuevoEstado, id);
  return nuevoEstado;
}

function eliminarItem(id) {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return info.changes > 0;
}

// Mueve al día de hoy cualquier pendiente sin completar que haya quedado de días anteriores
function rodarPendientesVencidos(hoyStr) {
  const nuevoTimestamp = `${hoyStr} 09:00:00`;
  const info = db.prepare(
    "UPDATE items SET creado_en = ? WHERE hecho = 0 AND substr(creado_en, 1, 10) < ?"
  ).run(nuevoTimestamp, hoyStr);
  return info.changes;
}

function obtenerItem(id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

function getConfig(clave, valorPorDefecto) {
  const row = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave);
  return row ? row.valor : valorPorDefecto;
}

function setConfig(clave, valor) {
  db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, String(valor));
}

module.exports = {
  db,
  listarCarpetas, crearCarpeta, editarCarpeta, eliminarCarpeta, normalizarClave,
  guardarItem, listarPendientes, listarTodos, listarUsuarios,
  marcarHecho, alternarHecho, eliminarItem, obtenerItem, rodarPendientesVencidos,
  getConfig, setConfig
};
