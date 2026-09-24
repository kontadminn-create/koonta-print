// Convierte el payload de un `trabajo_impresion` (ver contrato) en el HTML
// chico que se manda a imprimir. Nada de esto toca ESC/POS: Electron manda
// esto directo a la impresora de Windows con `webContents.print`.
function escapeHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatearHora(fechaHoraIso) {
  if (!fechaHoraIso) return '';
  const fecha = new Date(fechaHoraIso);
  if (Number.isNaN(fecha.getTime())) return escapeHtml(fechaHoraIso);
  return fecha.toLocaleString('es', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function anchoEnMm(anchoPapel) {
  return anchoPapel === '58mm' ? 58 : 80;
}

// `tipo` viene de reclamar_trabajo() ("comanda", "cancelacion" o "prueba").
// Si por algún motivo no llega, se deduce del payload como antes: una
// cancelación es la única con cantidades negativas.
function tituloSegunTipo(tipo, items) {
  if (tipo === 'cancelacion') return 'CANCELACIÓN';
  if (tipo === 'prueba') return 'PRUEBA';
  if (tipo === 'comanda') return 'COMANDA';
  return items.some((item) => item.cantidad < 0) ? 'CANCELACIÓN' : 'COMANDA';
}

function construirHtmlComanda(payload, { tipo = null, anchoPapel = '80mm' } = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const titulo = tituloSegunTipo(tipo, items);
  const esCancelacion = titulo === 'CANCELACIÓN';
  const anchoMm = anchoEnMm(anchoPapel);

  const filasItems = items
    .map((item) => {
      const cantidad = Math.abs(Number(item.cantidad) || 0);
      const nota = item.nota
        ? `<div class="nota">${esCancelacion ? 'Motivo' : 'Nota'}: ${escapeHtml(item.nota)}</div>`
        : '';
      return `
        <div class="item">
          <span class="cant">${cantidad}x</span>
          <span class="desc">${escapeHtml(item.descripcion)}</span>
        </div>
        ${nota}
      `;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #fff; color: #000; }
          body {
            font-family: "Courier New", monospace;
            font-size: ${anchoMm === 58 ? 12 : 13}px;
            width: ${anchoMm}mm;
          }
          .ticket { padding: 3mm 4mm 6mm; }
          h1 {
            font-size: ${anchoMm === 58 ? 15 : 17}px;
            text-align: center;
            margin: 0 0 2mm;
            letter-spacing: 1px;
          }
          h1.invertido { background: #000; color: #fff; padding: 1mm 0; }
          .encabezado {
            margin-bottom: 2mm;
            border-bottom: 1px dashed #000;
            padding-bottom: 2mm;
          }
          .fila { display: flex; justify-content: space-between; gap: 2mm; }
          .fila.grande { font-size: 1.15em; font-weight: bold; }
          .item { display: flex; gap: 2mm; margin-top: 2mm; font-weight: bold; }
          .cant { flex: none; }
          .desc { word-break: break-word; }
          .nota { padding-left: 6mm; font-style: italic; font-size: 0.92em; }
          .pie { margin-top: 3mm; border-top: 1px dashed #000; }
        </style>
      </head>
      <body>
        <div class="ticket" id="ticket">
          <h1 class="${esCancelacion ? 'invertido' : ''}">${titulo}</h1>
          <div class="encabezado">
            <div class="fila grande"><span>${escapeHtml(payload.zona)}</span><span>${escapeHtml(payload.mesa)}</span></div>
            <div class="fila"><span>${escapeHtml(payload.mesero)}</span><span>${formatearHora(payload.fecha_hora)}</span></div>
            ${payload.numero_comanda != null ? `<div class="fila"><span>N°</span><span>${escapeHtml(payload.numero_comanda)}</span></div>` : ''}
          </div>
          ${filasItems}
          <div class="pie"></div>
        </div>
      </body>
    </html>
  `;
}

// Electron necesita el tamaño de página en micrones. Un rollo térmico
// continuo avanza todo el alto de la página aunque esté en blanco, así que
// el alto se calcula del contenido ya renderizado (en px CSS, 96 por
// pulgada) en vez de mandar una hoja A4 fija que desperdiciaría papel en
// cada comanda. Si no se pudo medir, se usa un alto generoso de respaldo.
// El diseño de impresión de Chromium sale un poco más alto que la medida en
// pantalla (métricas de fuente), así que se suma un margen: sin él, la
// última línea se va a una segunda página. Los milímetros extra además le
// dan a la cuchilla espacio para cortar sin mochar el último ítem.
const MICRONES_POR_PX = 25400 / 96;
const FACTOR_SEGURIDAD_ALTO = 1.1;
const MARGEN_FINAL_MICRONES = 8 * 1000;
const ALTO_MINIMO_MICRONES = 30 * 1000;
const ALTO_RESPALDO_MICRONES = 297 * 1000;

function tamanioPagina(anchoPapel, altoContenidoPx = null) {
  const alto = Number(altoContenidoPx) > 0
    ? Math.max(ALTO_MINIMO_MICRONES, Math.ceil(altoContenidoPx * MICRONES_POR_PX * FACTOR_SEGURIDAD_ALTO) + MARGEN_FINAL_MICRONES)
    : ALTO_RESPALDO_MICRONES;
  return {
    width: anchoEnMm(anchoPapel) * 1000,
    height: alto,
  };
}

module.exports = { construirHtmlComanda, tamanioPagina };
