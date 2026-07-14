const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'datos.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpeta TEXT NOT NULL,
    contenido TEXT NOT NULL,
    hecho INTEGER DEFAULT 0,
    creado_en TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const CARPETAS = [
  'ideas',
  'recordatorios',
  'reuniones',
  'llamadas',
  'reparaciones_urgentes',
  'reparaciones_generales',
  'vehiculo'
];

function guardarItem(carpeta, contenido) {
  const stmt = db.prepare('INSERT INTO items (carpeta, contenido) VALUES (?, ?)');
  const info = stmt.run(carpeta, contenido);
  return info.lastInsertRowid;
}

function listarPendientes(carpeta = null) {
  if (carpeta) {
    return db.prepare('SELECT * FROM items WHERE hecho = 0 AND carpeta = ? ORDER BY id').all(carpeta);
  }
  return db.prepare('SELECT * FROM items WHERE hecho = 0 ORDER BY carpeta, id').all();
}

function marcarHecho(id) {
  const stmt = db.prepare('UPDATE items SET hecho = 1 WHERE id = ?');
  const info = stmt.run(id);
  return info.changes > 0;
}

function obtenerItem(id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

module.exports = { db, CARPETAS, guardarItem, listarPendientes, marcarHecho, obtenerItem };
