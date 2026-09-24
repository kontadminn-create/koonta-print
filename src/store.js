// Almacenamiento persistente en disco (no en memoria) de la sesión del equipo.
// Los tokens de Supabase (access/refresh) los guarda supabase-js directamente
// acá adentro, bajo sus propias claves (ver supabaseClient.js) — este store
// solo declara explícitamente lo que Koonta Print necesita leer por su cuenta.
const path = require('node:path');
const { app } = require('electron');
const Store = require('electron-store');

// `npm start` (desarrollo) y el .exe instalado deben quedar en carpetas
// completamente separadas en disco. Si no, una sesión real emparejada desde
// el programa instalado se filtra a cada prueba de desarrollo (y viceversa)
// — es justo lo que pasó una vez y no puede volver a pasar.
const cwd = app.isPackaged ? undefined : path.join(app.getPath('userData'), 'dev');

const store = new Store({
  name: 'sesion',
  cwd,
  defaults: {
    paired: false,
    equipoId: null,
    nombreEquipo: null,
  },
});

module.exports = store;
