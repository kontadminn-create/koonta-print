// Se suscribe a `trabajos_impresion` (paso 6 del contrato) solo como aviso de
// "algo pasó" -- la resolución real (qué trabajo es nuestro, en qué
// impresora, con qué ancho de papel/copias) la hace `reclamar_trabajo()` del
// lado del servidor, de forma atómica (FOR UPDATE SKIP LOCKED), así que dos
// llamadas simultáneas nunca se llevan el mismo trabajo dos veces.
const supabase = require('./supabaseClient');
const { procesarTrabajo } = require('./printJob');

// Respaldo por si el evento de Realtime se pierde (reconexión de socket,
// caída momentánea de la conexión, etc.) -- sin esto, un trabajo cuyo aviso
// no llegó se quedaría pendiente hasta el próximo INSERT que sí avise. El
// contrato v2 sugiere entre 5 y 10 segundos.
const INTERVALO_SONDEO_MS = 10_000;

let canal = null;
let sondeoRespaldo = null;
let activo = false;

// Realtime y el sondeo pueden disparar a la vez. En vez de correr dos
// vaciados en paralelo (que imprimirían en desorden), si ya hay uno en
// curso solo se anota que hay que dar otra vuelta al terminar.
let vaciando = false;
let otraVueltaPendiente = false;

async function vaciarCola() {
  // Una llamada se lleva como mucho un trabajo; repetimos hasta que
  // devuelva 0 filas para vaciar toda la cola de este equipo, no solo el
  // primero que había.
  while (activo) {
    const { data, error } = await supabase.rpc('reclamar_trabajo');
    if (error) {
      console.error('Koonta Print: fallo al reclamar trabajo:', error.message);
      return;
    }
    if (!data || data.length === 0) return;
    for (const trabajo of data) {
      await procesarTrabajo(trabajo);
    }
  }
}

async function reclamarYProcesarPendientes() {
  if (!activo) return;
  if (vaciando) {
    otraVueltaPendiente = true;
    return;
  }
  vaciando = true;
  try {
    do {
      otraVueltaPendiente = false;
      await vaciarCola();
    } while (otraVueltaPendiente && activo);
  } catch (err) {
    console.error('Koonta Print: error inesperado al procesar la cola:', err);
  } finally {
    vaciando = false;
  }
}

function iniciarEscucha() {
  if (canal) return;
  activo = true;

  canal = supabase
    .channel('trabajos_impresion-cambios')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trabajos_impresion' },
      () => {
        // El aviso no trae impresora resuelta ni nos dice si el trabajo es
        // nuestro -- eso lo decide reclamar_trabajo(), que además descarta
        // (0 filas) lo que no le pertenece a este equipo.
        reclamarYProcesarPendientes();
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        reclamarYProcesarPendientes();
      }
    });

  sondeoRespaldo = setInterval(reclamarYProcesarPendientes, INTERVALO_SONDEO_MS);
}

function detenerEscucha() {
  activo = false;
  if (canal) {
    supabase.removeChannel(canal);
    canal = null;
  }
  if (sondeoRespaldo) {
    clearInterval(sondeoRespaldo);
    sondeoRespaldo = null;
  }
}

// Para cuando el equipo vuelve de suspensión o recupera la conexión: no
// espera al siguiente ciclo del sondeo para imprimir lo acumulado.
function revisarAhora() {
  return reclamarYProcesarPendientes();
}

module.exports = { iniciarEscucha, detenerEscucha, revisarAhora };
