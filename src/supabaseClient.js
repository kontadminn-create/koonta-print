// Cliente único de Supabase para todo el proceso principal. Usamos electron-store
// como "localStorage" del SDK (el proceso principal no tiene localStorage real)
// para que la sesión sobreviva a un reinicio del computador sin volver a pedir
// el código de 6 dígitos.
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const store = require('./store');

// El proceso principal de Electron corre sobre el Node.js embebido, que no
// trae `WebSocket` global (a diferencia de un navegador). Sin esto, el canal
// realtime de Supabase (trabajos_impresion en vivo) no puede conectarse.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const SUPABASE_URL = 'https://jznmejimwnjfdxlwecan.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_5m87U7DLMLn1GSOrIVSEYA_kvvvWkl8';

const electronStoreAdapter = {
  getItem: (key) => store.get(`sb:${key}`, null),
  setItem: (key, value) => store.set(`sb:${key}`, value),
  removeItem: (key) => store.delete(`sb:${key}`),
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: electronStoreAdapter,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

module.exports = supabase;
