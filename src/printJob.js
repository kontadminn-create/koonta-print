// Imprime un trabajo ya resuelto por `reclamar_trabajo()` (impresora, ancho
// de papel y copias vienen calculados del lado del servidor a partir de
// comanderas.impresora_id -- este programa ya no guarda ningún mapeo propio,
// ver contrato en docs/contrato-trabajos-impresion.md) y reporta el
// resultado con `reportar_resultado_trabajo()`.
const { conVentana, reiniciarVentana } = require('./utilityWindow');
const supabase = require('./supabaseClient');
const { construirHtmlComanda, tamanioPagina } = require('./ticket');
const historialImpresiones = require('./historialImpresiones');

// Un driver que no responde nunca llama al callback de `print`; sin límite,
// ese único trabajo congelaría la cola para siempre.
const TIEMPO_LIMITE_IMPRESION_MS = 45_000;

// Si el reporte no llega, el trabajo se queda en 'imprimiendo' y a los 2
// minutos el servidor lo devuelve a 'pendiente' -- o sea, se imprimiría dos
// veces. Por eso se reintenta un par de veces antes de rendirse.
const ESPERAS_REINTENTO_REPORTE_MS = [0, 2000, 5000, 15000];

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reportarResultado(trabajoId, ok, detalle = null) {
  let ultimoError = null;
  for (const espera of ESPERAS_REINTENTO_REPORTE_MS) {
    if (espera) await esperar(espera);
    const { error } = await supabase.rpc('reportar_resultado_trabajo', {
      p_trabajo_id: trabajoId,
      p_ok: ok,
      p_detalle: detalle,
    });
    if (!error) return true;
    ultimoError = error;
  }
  console.error(`Koonta Print: no se pudo reportar el resultado del trabajo ${trabajoId}:`, ultimoError.message);
  return false;
}

function conTiempoLimite(promesa, ms, mensaje) {
  let temporizador;
  const limite = new Promise((_, reject) => {
    temporizador = setTimeout(() => reject(new Error(mensaje)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

function traducirErrorImpresion(errorType, nombreSistema) {
  if (errorType === 'Invalid deviceName provided') {
    return `La impresora "${nombreSistema}" no está instalada en este equipo.`;
  }
  if (errorType === 'cancelled') return 'La impresión se canceló.';
  return errorType || 'Fallo desconocido al imprimir.';
}

async function imprimirEnVentana(win, html, trabajo) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  let altoPx = null;
  try {
    altoPx = await win.webContents.executeJavaScript(
      'Math.ceil(document.getElementById("ticket").getBoundingClientRect().height)'
    );
  } catch {
    // Sin medida se usa el alto de respaldo (ver tamanioPagina).
  }

  const opciones = {
    silent: true,
    printBackground: true,
    deviceName: trabajo.nombre_sistema,
    copies: Math.min(Math.max(Number(trabajo.copias) || 1, 1), 5),
    pageSize: tamanioPagina(trabajo.ancho_papel, altoPx),
    margins: { marginType: 'none' },
  };

  await new Promise((resolve, reject) => {
    win.webContents.print(opciones, (success, errorType) => {
      if (success) resolve();
      else reject(new Error(traducirErrorImpresion(errorType, trabajo.nombre_sistema)));
    });
  });
}

async function procesarTrabajo(trabajo) {
  const payload = trabajo.payload || {};
  let estado = 'impreso';
  let detalle = null;

  try {
    if (!trabajo.nombre_sistema) {
      throw new Error('La comandera no tiene una impresora asignada.');
    }
    await conVentana(async (win) => {
      const html = construirHtmlComanda(payload, { tipo: trabajo.tipo, anchoPapel: trabajo.ancho_papel });
      try {
        await conTiempoLimite(
          imprimirEnVentana(win, html, trabajo),
          TIEMPO_LIMITE_IMPRESION_MS,
          `La impresora "${trabajo.nombre_sistema}" no respondió a tiempo.`
        );
      } catch (err) {
        reiniciarVentana();
        throw err;
      }
    });
  } catch (err) {
    estado = 'error';
    detalle = err.message;
  }

  await reportarResultado(trabajo.trabajo_id, estado === 'impreso', detalle);

  historialImpresiones.registrar({
    hora: new Date().toISOString(),
    zona: payload.zona || null,
    mesa: payload.mesa || null,
    estado,
    detalle,
  });
}

module.exports = { procesarTrabajo };
