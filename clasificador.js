const { CARPETAS } = require('./db');

// Clasifica un mensaje por palabras clave, sin depender de ninguna API externa (gratis)
const REGLAS = [
  { carpeta: 'reparaciones_urgentes', palabras: ['urgente', 'se rompió', 'se rompio', 'fuga', 'gotera', 'no funciona', 'emergencia'] },
  { carpeta: 'vehiculo', palabras: ['auto', 'carro', 'vehiculo', 'vehículo', 'neumático', 'neumatico', 'llanta', 'mecánico', 'mecanico', 'revisión técnica', 'revision tecnica'] },
  { carpeta: 'reparaciones_generales', palabras: ['reparar', 'arreglar', 'pintar', 'cambiar', 'mantención', 'mantencion', 'reparación', 'reparacion'] },
  { carpeta: 'reuniones', palabras: ['reunión', 'reunion', 'junta', 'meeting'] },
  { carpeta: 'llamadas', palabras: ['llamar', 'llamada', 'telefono', 'teléfono'] },
  { carpeta: 'ideas', palabras: ['idea', 'se me ocurrió', 'se me ocurrio', 'pensé en', 'pense en'] },
];

async function clasificarMensaje(texto) {
  const textoLower = texto.toLowerCase();
  for (const regla of REGLAS) {
    if (regla.palabras.some(p => textoLower.includes(p))) {
      return { carpeta: regla.carpeta, contenido: texto };
    }
  }
  return { carpeta: 'recordatorios', contenido: texto };
}

module.exports = { clasificarMensaje };
