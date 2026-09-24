const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('koontaPrint', {
  getStatus: () => ipcRenderer.invoke('koonta:get-status'),
  emparejar: (codigo) => ipcRenderer.invoke('koonta:emparejar', codigo),
  reintentar: () => ipcRenderer.invoke('koonta:reintentar'),
  impresorasAsignadas: () => ipcRenderer.invoke('koonta:impresoras-asignadas'),
  ultimasImpresiones: () => ipcRenderer.invoke('koonta:ultimas-impresiones'),
  abrirConfiguracion: () => ipcRenderer.invoke('koonta:abrir-configuracion'),
  abrirAyuda: () => ipcRenderer.invoke('koonta:abrir-ayuda'),
  cerrar: () => ipcRenderer.invoke('koonta:cerrar'),
  notificarAltura: (alto) => ipcRenderer.send('koonta:altura', alto),
  onCambioEstado: (callback) => ipcRenderer.on('koonta:estado-cambio', () => callback()),
  onCambioHistorial: (callback) => ipcRenderer.on('koonta:historial-cambio', () => callback()),
});
