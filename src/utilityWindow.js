// Ventana invisible que nunca se muestra: existe solo porque Electron necesita
// un `webContents` para poder listar impresoras del sistema y para imprimir
// (`printJob.js`). No es la ventana del panel de emparejamiento.
const { BrowserWindow } = require('electron');

let win = null;

function getUtilityWindow() {
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: false,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
      },
    });
  }
  return win;
}

// Si un driver de impresora se queda colgado y nunca llama al callback de
// `print`, la ventana queda inservible: se destruye para que la próxima
// tarea arranque con una limpia en vez de heredar el cuelgue.
function reiniciarVentana() {
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  win = null;
}

// La misma ventana sirve tanto para listar impresoras como para imprimir
// comandas; esta cola evita que dos operaciones le carguen contenido al
// mismo tiempo y se pisen.
let cola = Promise.resolve();
function conVentana(tarea) {
  const resultado = cola.then(() => tarea(getUtilityWindow()));
  cola = resultado.catch(() => {});
  return resultado;
}

module.exports = { getUtilityWindow, conVentana, reiniciarVentana };
