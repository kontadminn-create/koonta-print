const path = require('node:path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  shell,
  screen,
  powerMonitor,
  Notification,
} = require('electron');
const { isAuthRetryableFetchError } = require('@supabase/supabase-js');
const store = require('./store');
const supabase = require('./supabaseClient');
const { emparejar } = require('./pairing');
const { iniciarLatido, detenerLatido, reintentarAhora } = require('./heartbeat');
const { reportarImpresoras, listarImpresorasAsignadas } = require('./printers');
const { iniciarEscucha, detenerEscucha, revisarAhora } = require('./jobsQueue');
const historialImpresiones = require('./historialImpresiones');

const ICONO_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');

// Koonta web (repositorio aparte, konta-app). La gestión de equipos,
// códigos de emparejamiento, comanderas y zonas vive toda en la ruta
// /impresion (ver src/app/app.routes.ts de konta-app); no existe una página
// de ayuda separada, así que "Abrir guía" lleva al mismo lugar donde se
// genera el código.
const KOONTA_WEB_URL = 'https://konta-1bf.pages.dev';
const KOONTA_WEB_CONFIGURACION_URL = `${KOONTA_WEB_URL}/impresion`;
const KOONTA_AYUDA_URL = `${KOONTA_WEB_URL}/impresion`;

const ANCHO_PANEL = 400;
const ALTO_PANEL_INICIAL = 560;
const MARGEN_PANEL = 12;

// Margen antes de reportar latido/impresoras al encontrar una sesión ya
// emparejada al arrancar: le da tiempo a alguien de ver a qué negocio está
// conectado este equipo y cerrar el programa a tiempo si no correspondía.
const ESPERA_ANTES_DE_REPORTAR_MS = 8000;

// Cuando Windows arranca el programa solo, el panel se esconde un rato
// después de conectar: la caja no debería tener que cerrarlo a mano cada
// mañana.
const ESCONDER_TRAS_ARRANQUE_AUTOMATICO_MS = 6000;

// Las impresoras se vuelven a reportar cada tanto: si alguien instala una
// nueva, Koonta web la ve sin reiniciar el programa, y las que siguen
// conectadas refrescan su `ultima_vez_vista`.
const INTERVALO_REPORTE_IMPRESORAS_MS = 5 * 60_000;

// Sin red al arrancar (el Wi-Fi suele tardar más que el inicio de sesión de
// Windows), la sesión guardada no se puede validar todavía: se reintenta
// con esta espera en vez de darla por perdida.
const ESPERAS_RESTAURAR_MS = [3000, 5000, 10000, 15000, 30000];

const ARG_INICIO_AUTOMATICO = '--inicio-automatico';
const inicioAutomatico = process.argv.includes(ARG_INICIO_AUTOMATICO);

// Este programa vive en la bandeja del sistema: si dejamos que corran dos
// instancias, tendríamos dos íconos y dos conexiones peleando por la misma
// sesión emparejada. La segunda instancia se cierra sola y, en cambio, le
// avisamos a la primera que abra el panel.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let tray = null;
  let panelWindow = null;
  // 'desconectado': sin emparejar. 'restaurando': hay una sesión guardada
  // pero todavía no se pudo validar (típicamente, sin red al arrancar).
  // 'iniciando': hay sesión válida pero todavía no se reportó nada (ventana
  // de gracia). 'conectado': latido e impresoras ya se están reportando y
  // el último latido salió bien. 'sin-conexion': ya se emparejó y se
  // iniciaron los servicios, pero el último latido a Supabase falló (sin
  // internet, Supabase caído, etc).
  let estadoConexion = 'desconectado';
  let arranqueProgramadoPara = null;
  let reporteImpresorasId = null;
  let despertarRestauracion = null;

  if (process.platform === 'win32') {
    // Sin esto, las notificaciones de Windows salen con el nombre del
    // ejecutable de Electron en vez de "Koonta Print".
    app.setAppUserModelId('com.koonta.print');
  }

  app.on('second-instance', () => {
    showPanel();
  });

  // ---------- Panel ----------

  // Un programa de bandeja abre su panel pegado a la esquina donde está el
  // reloj, no en el centro de la pantalla.
  function posicionPanel(ancho, alto) {
    const { workArea } = screen.getPrimaryDisplay();
    return {
      x: Math.round(workArea.x + workArea.width - ancho - MARGEN_PANEL),
      y: Math.round(Math.max(workArea.y + MARGEN_PANEL, workArea.y + workArea.height - alto - MARGEN_PANEL)),
    };
  }

  function createPanelWindow() {
    const { x, y } = posicionPanel(ANCHO_PANEL, ALTO_PANEL_INICIAL);
    const win = new BrowserWindow({
      x,
      y,
      width: ANCHO_PANEL,
      height: ALTO_PANEL_INICIAL,
      show: false,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      frame: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#F1EFE8',
      icon: ICONO_PATH,
      title: 'Koonta Print',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // El panel nunca navega a otro lado ni abre ventanas propias: cualquier
    // enlace externo se abre en el navegador del sistema.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    // Un programa de bandeja no "se cierra" al hacer clic en la X, solo se
    // esconde. La única forma de terminarlo de verdad es el botón de cerrar
    // del propio panel o el menú de la bandeja (Alt+F4 también dispara este
    // evento aunque la ventana no tenga marco nativo).
    win.on('close', (event) => {
      if (!app.isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });

    // Sin marco nativo ya no hay botón de minimizar: perder el foco (clic
    // afuera del panel) es la forma de esconderlo sin cerrar el programa.
    // Durante la ventana de gracia no: ese aviso tiene que quedar a la vista.
    win.on('blur', () => {
      if (estadoConexion === 'iniciando') return;
      if (!win.isDestroyed() && win.isVisible()) {
        win.hide();
      }
    });

    return win;
  }

  function showPanel() {
    if (!panelWindow || panelWindow.isDestroyed()) {
      panelWindow = createPanelWindow();
      panelWindow.once('ready-to-show', () => {
        panelWindow.show();
        panelWindow.focus();
      });
      return;
    }
    const [ancho, alto] = panelWindow.getSize();
    const { x, y } = posicionPanel(ancho, alto);
    panelWindow.setPosition(x, y);
    panelWindow.show();
    panelWindow.focus();
  }

  function enviarAlPanel(canal, ...args) {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send(canal, ...args);
    }
  }

  // ---------- Bandeja ----------

  const TEXTO_ESTADO = {
    desconectado: 'Sin vincular',
    restaurando: 'Esperando conexión...',
    iniciando: 'Iniciando...',
    conectado: 'Conectado',
    'sin-conexion': 'Sin conexión',
  };

  function actualizarBandeja() {
    if (!tray || tray.isDestroyed()) return;
    const nombre = store.get('nombreEquipo');
    const estado = TEXTO_ESTADO[estadoConexion] || '';
    tray.setToolTip(`Koonta Print — ${estado}${nombre ? ` (${nombre})` : ''}`);

    const emparejado = estadoConexion === 'conectado' || estadoConexion === 'sin-conexion';
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Estado: ${estado}`, enabled: false },
        { type: 'separator' },
        { label: 'Abrir panel', click: showPanel },
        {
          label: 'Volver a buscar impresoras',
          enabled: emparejado,
          click: () => reportarImpresoras(),
        },
        { label: 'Abrir Koonta web', click: () => shell.openExternal(KOONTA_WEB_CONFIGURACION_URL) },
        { type: 'separator' },
        {
          label: 'Salir',
          click: () => {
            app.isQuitting = true;
            app.quit();
          },
        },
      ])
    );
  }

  function createTray() {
    const icon = nativeImage.createFromPath(ICONO_PATH);
    tray = new Tray(icon);
    tray.on('click', showPanel);
    tray.on('double-click', showPanel);
    actualizarBandeja();
  }

  // El panel no hace sondeo continuo salvo durante la cuenta regresiva de
  // "iniciando" -- para que se entere de un cambio de estado que pasa en
  // segundo plano (se cae la conexión, se cierra sesión) sin que nadie haya
  // tocado un botón, el proceso principal le avisa por este evento.
  function notificarCambioEstado() {
    actualizarBandeja();
    enviarAlPanel('koonta:estado-cambio');
  }

  function cambiarEstado(nuevoEstado) {
    if (nuevoEstado === estadoConexion) return;
    estadoConexion = nuevoEstado;
    notificarCambioEstado();
  }

  // ---------- Servicios del equipo ----------

  function alResultadoLatido({ ok, desvinculado, nombreNuevo }) {
    if (desvinculado) {
      // El equipo se desvinculó o eliminó desde Koonta web: su usuario de
      // Auth ya no existe. Se descarta la sesión local para volver a la
      // pantalla de vincular, en vez de quedar "sin conexión" para siempre.
      supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      desemparejarLocalmente();
      showPanel();
      return;
    }
    if (nombreNuevo) notificarCambioEstado();

    // Solo tiene sentido una vez que ya arrancamos los servicios del
    // equipo; antes de eso el estado lo maneja emparejar()/restaurarSesion.
    if (estadoConexion !== 'conectado' && estadoConexion !== 'sin-conexion') return;
    const volvio = ok && estadoConexion === 'sin-conexion';
    cambiarEstado(ok ? 'conectado' : 'sin-conexion');
    if (volvio) {
      // Lo que se acumuló mientras no había red se imprime ya, sin esperar
      // al siguiente ciclo del sondeo.
      revisarAhora();
      reportarImpresoras();
    }
  }

  // Arranca todo lo que depende de estar autenticado como dispositivo_impresion.
  async function iniciarServiciosDeEquipo() {
    if (estadoConexion === 'conectado' || estadoConexion === 'sin-conexion') return;
    arranqueProgramadoPara = null;
    cambiarEstado('conectado');
    iniciarLatido(alResultadoLatido);
    iniciarEscucha();
    await reportarImpresoras();
    if (!reporteImpresorasId) {
      reporteImpresorasId = setInterval(reportarImpresoras, INTERVALO_REPORTE_IMPRESORAS_MS);
    }
  }

  function detenerServiciosDeEquipo() {
    arranqueProgramadoPara = null;
    detenerLatido();
    detenerEscucha();
    if (reporteImpresorasId) {
      clearInterval(reporteImpresorasId);
      reporteImpresorasId = null;
    }
    cambiarEstado('desconectado');
  }

  function desemparejarLocalmente() {
    store.set('paired', false);
    store.set('equipoId', null);
    store.set('nombreEquipo', null);
    detenerServiciosDeEquipo();
  }

  const esperarRestauracion = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      despertarRestauracion = () => {
        clearTimeout(t);
        resolve();
      };
    }).finally(() => {
      despertarRestauracion = null;
    });

  async function restaurarSesionSiExiste() {
    if (!store.get('paired')) {
      // Primera vez (o se desvinculó): sin el panel a la vista, alguien que
      // recién instaló el programa no vería nada más que un ícono chico en
      // la bandeja y no sabría dónde poner el código.
      showPanel();
      return;
    }

    // Sin red, getSession() devuelve `session: null` junto con un error
    // reintentable, pero los tokens siguen guardados: no es lo mismo que una
    // sesión revocada. Se reintenta hasta que haya red de verdad.
    let intento = 0;
    for (;;) {
      let resultado;
      try {
        resultado = await supabase.auth.getSession();
      } catch (err) {
        resultado = { data: { session: null }, error: err };
      }
      const { data, error } = resultado;
      if (data && data.session) break;

      if (!error || !isAuthRetryableFetchError(error)) {
        // Los tokens guardados ya no sirven (refresh token vencido/revocado):
        // hay que volver a emparejar desde cero.
        desemparejarLocalmente();
        showPanel();
        return;
      }

      if (estadoConexion !== 'restaurando') cambiarEstado('restaurando');
      const espera = ESPERAS_RESTAURAR_MS[Math.min(intento, ESPERAS_RESTAURAR_MS.length - 1)];
      intento += 1;
      await esperarRestauracion(espera);
      // Alguien pudo haber emparejado a mano o cerrado sesión en el ínterin.
      if (estadoConexion !== 'restaurando') return;
    }

    // Encontramos una sesión ya emparejada sin que nadie la haya pedido
    // ahora mismo (el programa recién arrancó). Mostramos el panel con el
    // nombre del equipo ANTES de tocar nada en Supabase: si esto no
    // corresponde a este negocio/máquina, hay unos segundos para cerrarlo.
    arranqueProgramadoPara = Date.now() + ESPERA_ANTES_DE_REPORTAR_MS;
    cambiarEstado('iniciando');
    showPanel();

    await new Promise((resolve) => setTimeout(resolve, ESPERA_ANTES_DE_REPORTAR_MS));

    // Si en el ínterin alguien emparejó a mano, cerró sesión, o mató el
    // proceso, no pisamos ese resultado.
    if (estadoConexion === 'iniciando') {
      await iniciarServiciosDeEquipo();
      if (inicioAutomatico) {
        setTimeout(() => {
          if (panelWindow && !panelWindow.isDestroyed() && estadoConexion === 'conectado') {
            panelWindow.hide();
          }
        }, ESCONDER_TRAS_ARRANQUE_AUTOMATICO_MS);
      }
    }
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && store.get('paired')) {
      desemparejarLocalmente();
    }
  });

  // ---------- Avisos de impresión ----------

  historialImpresiones.suscribir((entrada) => {
    enviarAlPanel('koonta:historial-cambio');
    if (entrada.estado !== 'error' || !Notification.isSupported()) return;
    const donde = [entrada.mesa, entrada.zona].filter(Boolean).join(' · ') || 'Comanda';
    const aviso = new Notification({
      title: 'No se pudo imprimir una comanda',
      body: `${donde}: ${entrada.detalle || 'error desconocido'}`,
      icon: ICONO_PATH,
    });
    aviso.on('click', showPanel);
    aviso.show();
  });

  // ---------- IPC con el panel ----------

  ipcMain.handle('koonta:get-status', async () => {
    return {
      paired: store.get('paired'),
      nombreEquipo: store.get('nombreEquipo'),
      estadoConexion,
      version: app.getVersion(),
      segundosRestantes: arranqueProgramadoPara
        ? Math.max(0, Math.ceil((arranqueProgramadoPara - Date.now()) / 1000))
        : null,
    };
  });

  // Se devuelve { ok, error } en vez de lanzar: un error lanzado desde
  // ipcMain.handle le llega al panel con el prefijo técnico "Error invoking
  // remote method 'koonta:emparejar': Error: ...", que no se le puede
  // mostrar así a quien está en la caja.
  ipcMain.handle('koonta:emparejar', async (_event, codigo) => {
    const codigoLimpio = String(codigo || '').replace(/\D/g, '');
    if (codigoLimpio.length !== 6) {
      return { ok: false, error: 'El código debe tener 6 dígitos.' };
    }
    try {
      const resultado = await emparejar(codigoLimpio);
      // Si había un reintento de restauración en curso, este emparejamiento
      // manual lo reemplaza.
      if (despertarRestauracion) despertarRestauracion();
      if (estadoConexion !== 'desconectado') detenerServiciosDeEquipo();
      await iniciarServiciosDeEquipo();
      return { ok: true, ...resultado };
    } catch (err) {
      return { ok: false, error: err.message || 'No se pudo vincular el equipo.' };
    }
  });

  ipcMain.handle('koonta:reintentar', async () => {
    if (estadoConexion === 'restaurando') {
      if (despertarRestauracion) despertarRestauracion();
      return;
    }
    const ok = await reintentarAhora();
    if (ok) revisarAhora();
  });

  ipcMain.handle('koonta:impresoras-asignadas', async () => {
    return listarImpresorasAsignadas();
  });

  ipcMain.handle('koonta:ultimas-impresiones', async () => {
    return historialImpresiones.obtener();
  });

  ipcMain.handle('koonta:abrir-configuracion', () => {
    shell.openExternal(KOONTA_WEB_CONFIGURACION_URL);
  });

  ipcMain.handle('koonta:abrir-ayuda', () => {
    shell.openExternal(KOONTA_AYUDA_URL);
  });

  ipcMain.handle('koonta:cerrar', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.on('koonta:altura', (_event, alto) => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const altoValido = Math.round(Math.min(Math.max(Number(alto) || 0, 200), 900));
    panelWindow.setContentSize(ANCHO_PANEL, altoValido);
    // Al crecer hacia abajo se metería debajo de la barra de tareas: se
    // vuelve a anclar a la esquina con el alto nuevo.
    const [ancho, altoVentana] = panelWindow.getSize();
    const { x, y } = posicionPanel(ancho, altoVentana);
    panelWindow.setPosition(x, y);
  });

  // ---------- Arranque ----------

  app.whenReady().then(async () => {
    // Sin esto, Electron sigue dibujando la barra de menú por defecto
    // (Archivo/Edición/Ver/Ventana/Ayuda) en cualquier ventana que se cree,
    // aunque el panel ya trae su propia barra de título.
    Menu.setApplicationMenu(null);

    // La caja de un negocio no debería depender de que alguien abra este
    // programa a mano cada mañana. En desarrollo (`npm start`) esto se
    // salta para no registrar el electron.exe crudo como inicio de sesión.
    // El argumento marca que fue Windows quien lo abrió, para esconder el
    // panel solo una vez conectado.
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: [ARG_INICIO_AUTOMATICO],
      });
    }

    // Al volver de suspensión o desbloquear la sesión, la conexión suele
    // haberse caído y vuelto: se late y se revisa la cola en el acto, sin
    // esperar al próximo ciclo.
    const alDespertar = () => {
      if (estadoConexion === 'restaurando' && despertarRestauracion) {
        despertarRestauracion();
        return;
      }
      if (estadoConexion === 'conectado' || estadoConexion === 'sin-conexion') {
        reintentarAhora();
        revisarAhora();
      }
    };
    powerMonitor.on('resume', alDespertar);
    powerMonitor.on('unlock-screen', alDespertar);

    createTray();
    await restaurarSesionSiExiste();
  });

  // Si no nos suscribimos a este evento, Electron cierra la app entera en
  // cuanto se cierra la última ventana. Aquí lo hacemos a propósito: la app
  // debe seguir viva en la bandeja aunque el panel esté escondido.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    app.isQuitting = true;
    detenerLatido();
    detenerEscucha();
  });
}
