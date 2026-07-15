const { CARPETAS } = require('./db');

const REGLAS = [
  {
    carpeta: 'reparaciones_urgentes',
    peso: 3,
    palabras: ['urgente', 'urgencia', 'se rompió', 'se rompio', 'se quebró', 'se quebro',
      'fuga', 'gotera', 'inundó', 'inundo', 'no funciona', 'no prende', 'no enciende',
      'emergencia', 'se inundó', 'se inundo', 'corte de luz', 'corto circuito', 'huele a gas']
  },
  {
    carpeta: 'vehiculo',
    peso: 2,
    palabras: ['auto', 'carro', 'vehiculo', 'vehículo', 'coche', 'neumático', 'neumatico',
      'llanta', 'llantas', 'batería del auto', 'bateria del auto', 'aceite del auto',
      'aceite del carro', 'mecánico', 'mecanico', 'taller', 'revisión técnica',
      'revision tecnica', 'permiso de circulación', 'permiso de circulacion',
      'seguro del auto', 'frenos', 'motor del auto', 'patente']
  },
  {
    carpeta: 'reuniones',
    peso: 2,
    palabras: ['reunión', 'reunion', 'junta', 'meeting', 'cita con', 'agendar con']
  },
  {
    carpeta: 'llamadas',
    peso: 2,
    palabras: ['llamar a', 'llamar por', 'hacer una llamada', 'llamada', 'teléfono a',
      'telefono a', 'devolver la llamada']
  },
  {
    carpeta: 'ideas',
    peso: 2,
    palabras: ['idea', 'se me ocurrió', 'se me ocurrio', 'pensé en', 'pense en',
      'qué tal si', 'que tal si', 'sería bueno', 'seria bueno']
  },
  {
    carpeta: 'reparaciones_generales',
    peso: 1,
    palabras: ['reparar', 'arreglar', 'pintar', 'cambiar', 'mantención', 'mantencion',
      'reparación', 'reparacion', 'instalar', 'revisar la casa', 'limpiar el',
      'destapar', 'atornillar']
  },
];

function normalizar(texto) {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function clasificarMensaje(texto) {
  const textoNorm = normalizar(texto);
  let mejorCarpeta = null;
  let mejorPuntaje = 0;

  for (const regla of REGLAS) {
    let puntaje = 0;
    for (const palabra of regla.palabras) {
      if (textoNorm.includes(normalizar(palabra))) {
        puntaje += regla.peso;
      }
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorCarpeta = regla.carpeta;
    }
  }

  return { carpeta: mejorCarpeta || 'recordatorios', contenido: texto };
}

module.exports = { clasificarMensaje };
