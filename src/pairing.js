// Emparejamiento real: llama a la Edge Function `emparejar-equipo` con el
// código de 6 dígitos generado desde Koonta web y, si es válido, deja al
// programa autenticado como `dispositivo_impresion` (ver contrato en
// docs/contrato-trabajos-impresion.md).
const supabase = require('./supabaseClient');
const store = require('./store');

async function extraerMensajeError(error) {
  if (!error) return 'Error desconocido.';
  // Sin internet (o con Supabase inalcanzable) la petición ni siquiera
  // llega a la Edge Function: el mensaje técnico de supabase-js no le dice
  // nada a quien está en la caja.
  if (error.name === 'FunctionsFetchError') {
    return 'No se pudo conectar con Koonta. Revisa la conexión a internet e intenta de nuevo.';
  }
  // Cuando la Edge Function responde con un error HTTP (código inválido o
  // vencido), supabase-js expone la respuesta cruda en `error.context`.
  if (error.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.json();
      if (body && body.error) return body.error;
      if (body && body.message) return body.message;
    } catch {
      // El cuerpo no era JSON: seguimos con error.message.
    }
  }
  return error.message || 'No se pudo emparejar el equipo.';
}

async function emparejar(codigo) {
  const { data, error } = await supabase.functions.invoke('emparejar-equipo', {
    body: { codigo },
  });

  if (error) {
    throw new Error(await extraerMensajeError(error));
  }

  const { equipoId, nombreEquipo, accessToken, refreshToken } = data || {};
  if (!equipoId || !accessToken || !refreshToken) {
    throw new Error('Respuesta inesperada del servidor al emparejar.');
  }

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (sessionError) {
    throw new Error('El código era válido pero no se pudo iniciar sesión: ' + sessionError.message);
  }

  store.set('equipoId', equipoId);
  store.set('nombreEquipo', nombreEquipo || null);
  store.set('paired', true);

  return { equipoId, nombreEquipo };
}

module.exports = { emparejar };
