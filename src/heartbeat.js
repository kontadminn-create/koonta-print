// Late cada 60s vía `registrar_latido_equipo()` para que Koonta web muestre
// este equipo como "En línea" (se considera desconectado a los 2 minutos
// sin latido, según el contrato). Además, cada intento le avisa a quien se
// suscribió si salió bien o mal -- así el panel puede mostrar la pantalla
// de "Sin conexión" en cuanto Supabase deja de responder, sin esperar los
// 2 minutos del contrato (eso es para que lo vea Koonta web, no para lo
// que muestra este mismo programa de sí mismo).
//
// `registrar_latido_equipo()` no falla si el equipo ya no existe (hace un
// update que simplemente no toca ninguna fila), así que un equipo
// desvinculado desde Koonta web seguiría "latiendo" sin enterarse. Por eso
// cada latido también le pregunta a Auth si este usuario sigue existiendo:
// `desvincular-equipo` lo borra de Auth, y a partir de ahí `getUser()`
// responde 403/404 aunque el access token local todavía no haya vencido.
const supabase = require('./supabaseClient');
const store = require('./store');

const INTERVALO_MS = 60_000;

// Se exigen dos respuestas seguidas de "usuario inexistente" antes de dar
// al equipo por desvinculado: cerrar la sesión local es irreversible sin un
// código nuevo, y no se hace por una sola respuesta rara.
const CONFIRMACIONES_DESVINCULADO = 2;

let intervalId = null;
let onResultado = null;
let respuestasDesvinculado = 0;

async function verificarVinculo() {
  const { error } = await supabase.auth.getUser();
  if (error && (error.status === 403 || error.status === 404)) {
    respuestasDesvinculado += 1;
  } else if (!error) {
    respuestasDesvinculado = 0;
  }
  return respuestasDesvinculado >= CONFIRMACIONES_DESVINCULADO;
}

// Si alguien renombró el equipo desde Koonta web, el panel lo refleja sin
// volver a emparejar. Solo lectura, y solo si la fila llega de verdad.
async function refrescarNombreEquipo() {
  const equipoId = store.get('equipoId');
  if (!equipoId) return null;
  const { data, error } = await supabase
    .from('equipos_impresion')
    .select('nombre')
    .eq('id', equipoId)
    .maybeSingle();
  if (error || !data || !data.nombre) return null;
  if (data.nombre !== store.get('nombreEquipo')) {
    store.set('nombreEquipo', data.nombre);
    return data.nombre;
  }
  return null;
}

async function latir() {
  let ok = false;
  let desvinculado = false;
  let nombreNuevo = null;
  try {
    const { error } = await supabase.rpc('registrar_latido_equipo');
    if (error) {
      console.error('Koonta Print: fallo el latido:', error.message);
    }
    ok = !error;
    if (ok) {
      desvinculado = await verificarVinculo();
      if (!desvinculado) nombreNuevo = await refrescarNombreEquipo();
    }
  } catch (err) {
    console.error('Koonta Print: error inesperado en el latido:', err);
    ok = false;
  }
  if (onResultado) onResultado({ ok, desvinculado, nombreNuevo });
  return ok;
}

function iniciarLatido(callback) {
  onResultado = callback || null;
  if (intervalId) return;
  respuestasDesvinculado = 0;
  latir();
  intervalId = setInterval(latir, INTERVALO_MS);
}

function detenerLatido() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  onResultado = null;
  respuestasDesvinculado = 0;
}

// Fuerza un intento fuera de ciclo (botón "Reintentar ahora" de la pantalla
// de sin conexión, o al volver de suspensión). Reporta el resultado por el
// mismo callback que el intervalo normal.
function reintentarAhora() {
  return latir();
}

module.exports = { iniciarLatido, detenerLatido, reintentarAhora };
