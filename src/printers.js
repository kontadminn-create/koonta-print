// Detecta las impresoras que Windows ya tiene instaladas y las reporta a
// Supabase con el RPC `sincronizar_impresoras(p_lista)` para que Koonta web
// sepa qué hay disponible en este equipo. Ver contrato, paso 5.
//
// Desde la migración 0031 el rol `dispositivo_impresion` ya no tiene policy
// de insert/update sobre `impresoras_reportadas`: un `upsert` directo falla
// siempre. La única vía de escritura es este RPC (security definer), que
// además resuelve el equipo por la sesión, sin mandar `equipo_id` a mano.
const { conVentana } = require('./utilityWindow');
const supabase = require('./supabaseClient');
const store = require('./store');

const IP_REGEX = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

function clasificar(printerInfo) {
  const textoOpciones = JSON.stringify(printerInfo.options || {}) + ' ' + (printerInfo.description || '');
  const match = textoOpciones.match(IP_REGEX);
  if (match) {
    return { tipo: 'red', direccionRed: match[0] };
  }
  return { tipo: 'local', direccionRed: null };
}

async function listarImpresorasLocales() {
  return conVentana(async (win) => {
    if (win.webContents.getURL() === '') {
      await win.loadURL('about:blank');
    }
    const impresoras = await win.webContents.getPrintersAsync();
    return impresoras.map((p) => ({
      nombreSistema: p.name,
      nombreVisible: p.displayName || p.name,
      ...clasificar(p),
    }));
  });
}

// Devuelve true si Supabase aceptó la lista (o si no había nada que
// reportar), false si falló -- quien llama decide si reintenta.
async function reportarImpresoras() {
  if (!store.get('equipoId')) return false;

  let impresoras;
  try {
    impresoras = await listarImpresorasLocales();
  } catch (err) {
    console.error('Koonta Print: no se pudieron listar las impresoras de Windows:', err.message);
    return false;
  }
  if (impresoras.length === 0) return true;

  const lista = impresoras.map((imp) => ({
    nombre_sistema: imp.nombreSistema,
    tipo: imp.tipo,
    direccion_red: imp.direccionRed,
  }));

  const { error } = await supabase.rpc('sincronizar_impresoras', { p_lista: lista });
  if (error) {
    console.error('Koonta Print: fallo al reportar impresoras:', error.message);
    return false;
  }
  return true;
}

// Lectura de solo consulta (nunca reclama nada) para la tarjeta "IMPRESORAS
// ASIGNADAS" del panel: qué impresora de este equipo tiene una comandera
// activa y a qué zona la mandó Koonta web. `comanderas` y `zonas_comanda`
// usan usuario_pertenece_a_negocio() en su policy de select (0025), así que
// el dispositivo sí puede leerlas. Si algo falla, se devuelve una lista
// vacía, nunca un error, para que el panel muestre su estado vacío en vez
// de romperse.
async function listarImpresorasAsignadas() {
  const equipoId = store.get('equipoId');
  if (!equipoId) return [];

  const { data, error } = await supabase
    .from('impresoras_reportadas')
    .select('id, nombre_sistema, tipo, comanderas ( id, activa, archivada, zonas_comanda ( id, nombre ) )')
    .eq('equipo_id', equipoId);

  if (error) {
    console.error('Koonta Print: no se pudieron leer las impresoras asignadas:', error.message);
    return [];
  }

  const filas = [];
  for (const impresora of data || []) {
    for (const comandera of impresora.comanderas || []) {
      // Una comandera desactivada o archivada no recibe trabajos: mostrarla
      // como "asignada" haría creer que esa zona sí imprime acá.
      if (comandera.activa === false || comandera.archivada === true) continue;
      for (const zona of comandera.zonas_comanda || []) {
        filas.push({ nombreSistema: impresora.nombre_sistema, zona: zona.nombre });
      }
    }
  }
  return filas;
}

module.exports = { listarImpresorasLocales, reportarImpresoras, listarImpresorasAsignadas };
