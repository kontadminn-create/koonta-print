// Historial en memoria de los últimos trabajos procesados, solo para
// mostrarlo en el panel ("ÚLTIMAS IMPRESIONES") -- no es un registro
// permanente (eso ya lo es `trabajos_impresion` del lado del servidor) y se
// reinicia si el programa se reinicia, a propósito, para no crecer el
// store en disco por algo puramente informativo.
const MAX_HISTORIAL = 8;

let historial = [];
const suscriptores = new Set();

function registrar({ hora, zona, mesa, estado, detalle = null }) {
  const entrada = { hora, zona, mesa, estado, detalle };
  historial.unshift(entrada);
  if (historial.length > MAX_HISTORIAL) {
    historial.length = MAX_HISTORIAL;
  }
  for (const fn of suscriptores) {
    try {
      fn(entrada);
    } catch (err) {
      console.error('Koonta Print: fallo un suscriptor del historial:', err);
    }
  }
}

function obtener() {
  return historial;
}

// El proceso principal se suscribe para refrescar el panel en vivo y
// avisar con una notificación de Windows cuando algo no se pudo imprimir.
function suscribir(fn) {
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

module.exports = { registrar, obtener, suscribir };
