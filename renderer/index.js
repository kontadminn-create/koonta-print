const contenidoEl = document.getElementById('contenido');
const titlebarEl = document.querySelector('.titlebar');

const panelEmparejar = document.getElementById('panel-emparejar');
const panelArrancando = document.getElementById('panel-arrancando');
const panelConectado = document.getElementById('panel-conectado');
const panelSinConexion = document.getElementById('panel-sin-conexion');

const nombreEquipoArranqueEl = document.getElementById('nombre-equipo-arranque');
const cuentaRegresivaEl = document.getElementById('cuenta-regresiva');
const nombreEquipoEl = document.getElementById('nombre-equipo');

const casillas = Array.from(document.querySelectorAll('.casilla'));
const btnEmparejar = document.getElementById('btn-emparejar');
const errorEmparejar = document.getElementById('error-emparejar');
const linkAyuda = document.getElementById('link-ayuda');

const btnCerrar = document.getElementById('btn-cerrar');
const btnCerrarAviso = document.getElementById('btn-cerrar-aviso');
const btnReintentar = document.getElementById('btn-reintentar');
const btnConfigurar = document.getElementById('btn-configurar');

const listaImpresorasEl = document.getElementById('lista-impresoras');
const listaImpresionesEl = document.getElementById('lista-impresiones');

const sinConexionTituloEl = document.getElementById('sin-conexion-titulo');
const sinConexionSubtituloEl = document.getElementById('sin-conexion-subtitulo');
const versionEl = document.getElementById('version');

let sondeoArranque = null;

// El nombre del negocio (distinto del nombre del equipo) todavía no llega
// en ningún dato que exponga el proceso principal -- emparejar-equipo solo
// entrega equipoId/nombreEquipo. Los elementos que lo mostrarían
// (#nombre-negocio, #negocio-arranque) se dejan en el HTML, ocultos, listos
// para cuando exista ese dato; no se rellenan con nada inventado.

function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ocultarTodosLosPaneles() {
  panelEmparejar.classList.add('oculto');
  panelArrancando.classList.add('oculto');
  panelConectado.classList.add('oculto');
  panelSinConexion.classList.add('oculto');
}

function formatearCuentaRegresiva(segundos) {
  const s = Math.max(0, segundos != null ? segundos : 0);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function renderEstado({ paired, nombreEquipo, estadoConexion, segundosRestantes, version }) {
  if (version) versionEl.textContent = `v${version}`;

  if (!paired) {
    detenerSondeoArranque();
    const yaVisible = !panelEmparejar.classList.contains('oculto');
    ocultarTodosLosPaneles();
    panelEmparejar.classList.remove('oculto');
    if (!yaVisible) {
      casillas.forEach((c) => {
        c.value = '';
      });
      actualizarBotonEmparejar();
      casillas[0].focus();
    }
    return;
  }

  // Hay una sesión guardada pero todavía no se pudo validar (lo típico:
  // Windows arrancó antes que el Wi-Fi). Misma pantalla que "sin conexión",
  // pero sin dar a entender que algo se rompió.
  if (estadoConexion === 'restaurando') {
    detenerSondeoArranque();
    ocultarTodosLosPaneles();
    panelSinConexion.classList.remove('oculto');
    sinConexionTituloEl.textContent = 'Esperando conexión';
    sinConexionSubtituloEl.textContent = nombreEquipo
      ? `${nombreEquipo} se conectará en cuanto haya internet.`
      : 'El equipo se conectará en cuanto haya internet.';
    return;
  }

  if (estadoConexion === 'iniciando') {
    ocultarTodosLosPaneles();
    panelArrancando.classList.remove('oculto');
    nombreEquipoArranqueEl.textContent = nombreEquipo || '(sin nombre)';
    cuentaRegresivaEl.textContent = formatearCuentaRegresiva(segundosRestantes);
    iniciarSondeoArranque();
    return;
  }

  if (estadoConexion === 'sin-conexion') {
    detenerSondeoArranque();
    ocultarTodosLosPaneles();
    panelSinConexion.classList.remove('oculto');
    sinConexionTituloEl.textContent = 'Sin conexión';
    sinConexionSubtituloEl.textContent = 'Reintentando conectar con Koonta web...';
    return;
  }

  // estadoConexion === 'conectado'
  detenerSondeoArranque();
  ocultarTodosLosPaneles();
  panelConectado.classList.remove('oculto');
  nombreEquipoEl.textContent = nombreEquipo || '(sin nombre)';
  cargarImpresorasAsignadas();
  cargarUltimasImpresiones();
}

function iniciarSondeoArranque() {
  if (sondeoArranque) return;
  sondeoArranque = setInterval(async () => {
    const status = await window.koontaPrint.getStatus();
    renderEstado(status);
  }, 1000);
}

function detenerSondeoArranque() {
  if (sondeoArranque) {
    clearInterval(sondeoArranque);
    sondeoArranque = null;
  }
}

async function cargarImpresorasAsignadas() {
  try {
    const impresoras = await window.koontaPrint.impresorasAsignadas();
    if (!impresoras || impresoras.length === 0) {
      listaImpresorasEl.innerHTML =
        '<li class="lista-vacia">Sin impresoras asignadas todavía — configúralas desde Koonta web.</li>';
      return;
    }
    listaImpresorasEl.innerHTML = impresoras
      .map(
        (imp) => `
          <li class="fila-lista">
            <span class="fila-lista-principal">${escapeHtml(imp.nombreSistema)}</span>
            <span class="fila-lista-secundaria">${escapeHtml(imp.zona)}</span>
            <span class="punto punto--verde"></span>
          </li>
        `
      )
      .join('');
  } catch (err) {
    console.error('No se pudieron cargar las impresoras asignadas:', err);
    listaImpresorasEl.innerHTML =
      '<li class="lista-vacia">Sin impresoras asignadas todavía — configúralas desde Koonta web.</li>';
  }
}

function formatearHora(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '--:--';
  return fecha.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function cargarUltimasImpresiones() {
  try {
    const impresiones = await window.koontaPrint.ultimasImpresiones();
    if (!impresiones || impresiones.length === 0) {
      listaImpresionesEl.innerHTML =
        '<li class="lista-vacia">Todavía no se imprimió ninguna comanda en este equipo.</li>';
      return;
    }
    listaImpresionesEl.innerHTML = impresiones
      .map((trabajo) => {
        const mesaZona = [trabajo.mesa, trabajo.zona].filter(Boolean).join(' · ') || 'Comanda';
        const esError = trabajo.estado === 'error';
        const detalle = esError && trabajo.detalle ? ` title="${escapeHtml(trabajo.detalle)}"` : '';
        return `
          <li class="fila-lista"${detalle}>
            <span class="fila-lista-hora mono">${formatearHora(trabajo.hora)}</span>
            <span class="fila-lista-principal">${escapeHtml(mesaZona)}</span>
            <span class="pildora ${esError ? 'pildora--roja' : 'pildora--verde'}">${esError ? 'ERROR' : 'IMPRESO'}</span>
          </li>
        `;
      })
      .join('');
  } catch (err) {
    console.error('No se pudieron cargar las últimas impresiones:', err);
    listaImpresionesEl.innerHTML =
      '<li class="lista-vacia">Todavía no se imprimió ninguna comanda en este equipo.</li>';
  }
}

// ---------- Casillas del código de emparejamiento ----------

function valorCodigo() {
  return casillas.map((c) => c.value).join('');
}

function actualizarBotonEmparejar() {
  btnEmparejar.disabled = valorCodigo().length !== 6;
}

casillas.forEach((casilla, indice) => {
  casilla.addEventListener('input', () => {
    casilla.value = casilla.value.replace(/\D/g, '').slice(0, 1);
    errorEmparejar.classList.add('oculto');
    if (casilla.value && indice < casillas.length - 1) {
      casillas[indice + 1].focus();
    }
    actualizarBotonEmparejar();
  });

  casilla.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !casilla.value && indice > 0) {
      casillas[indice - 1].focus();
    }
    if (event.key === 'Enter' && !btnEmparejar.disabled) {
      btnEmparejar.click();
    }
  });

  casilla.addEventListener('paste', (event) => {
    const texto = (event.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    if (!texto) return;
    event.preventDefault();
    casillas.forEach((c, i) => {
      c.value = texto[i] || '';
    });
    const indiceEnfoque = Math.min(texto.length, casillas.length) - 1;
    if (indiceEnfoque >= 0) casillas[indiceEnfoque].focus();
    actualizarBotonEmparejar();
  });
});

btnEmparejar.addEventListener('click', async () => {
  btnEmparejar.disabled = true;
  btnEmparejar.textContent = 'Vinculando...';
  errorEmparejar.classList.add('oculto');
  try {
    const resultado = await window.koontaPrint.emparejar(valorCodigo());
    if (!resultado || !resultado.ok) {
      throw new Error((resultado && resultado.error) || 'No se pudo vincular el equipo.');
    }
    const status = await window.koontaPrint.getStatus();
    renderEstado(status);
  } catch (err) {
    errorEmparejar.textContent = err.message || 'No se pudo vincular el equipo.';
    errorEmparejar.classList.remove('oculto');
    btnEmparejar.disabled = false;
  } finally {
    btnEmparejar.textContent = 'Vincular equipo';
  }
});

// ---------- Botones ----------

btnCerrar.addEventListener('click', () => window.koontaPrint.cerrar());
btnCerrarAviso.addEventListener('click', () => window.koontaPrint.cerrar());

btnReintentar.addEventListener('click', async () => {
  btnReintentar.disabled = true;
  btnReintentar.textContent = 'Reintentando...';
  try {
    await window.koontaPrint.reintentar();
    const status = await window.koontaPrint.getStatus();
    renderEstado(status);
  } finally {
    btnReintentar.disabled = false;
    btnReintentar.textContent = 'Reintentar ahora';
  }
});

btnConfigurar.addEventListener('click', () => window.koontaPrint.abrirConfiguracion());
linkAyuda.addEventListener('click', (event) => {
  event.preventDefault();
  window.koontaPrint.abrirAyuda();
});

// ---------- Alto de ventana ajustado al contenido ----------

let ultimaAlturaEnviada = 0;

function notificarAlturaSiCambio() {
  const alto = contenidoEl.scrollHeight + titlebarEl.offsetHeight;
  if (Math.abs(alto - ultimaAlturaEnviada) < 2) return;
  ultimaAlturaEnviada = alto;
  window.koontaPrint.notificarAltura(alto);
}

new ResizeObserver(notificarAlturaSiCambio).observe(contenidoEl);

window.koontaPrint.onCambioEstado(async () => {
  const status = await window.koontaPrint.getStatus();
  renderEstado(status);
});

// Cada comanda impresa (o fallida) refresca la lista en el acto, sin
// esperar a que alguien vuelva a abrir el panel.
window.koontaPrint.onCambioHistorial(() => {
  if (!panelConectado.classList.contains('oculto')) cargarUltimasImpresiones();
});

window.koontaPrint.getStatus().then(renderEstado);
