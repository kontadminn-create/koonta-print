# Contrato de `trabajos_impresion` — Koonta Print (v2)

Este documento es el contrato entre Koonta (la web) y Koonta Print (el programa de
escritorio, todavía por escribir). Todo lo que Koonta Print necesita saber para
imprimir comandas está acá. Si esta forma cambia alguna vez, hay que actualizar
este archivo Y el comentario de columna en la migración `0026_trabajos_impresion.sql`
en el mismo commit.

**v2** (migración `0031_contrato_v2_koonta_print.sql`) reemplaza el `update` directo
del paso 7 de la v1 por dos RPC atómicos (`reclamar_trabajo()` /
`reportar_resultado_trabajo()`) y cierra un hueco real de RLS: antes,
`dispositivo_impresion` podía leer cualquier tabla cuya policy de select usara
`usuario_pertenece_a_negocio()` sin filtrar por rol -- incluidos precios de
`productos` y el resto de datos financieros. Nunca se explotó (el programa no
existe todavía), pero un programa nuevo escrito contra la v1 **no debe** escribir
`estado` directo a la tabla: esa policy ya no existe.

## Cómo se conecta Koonta Print

1. La tienda genera un código de 6 dígitos desde **Configuración → Impresión**
   (`generar_codigo_emparejamiento`, válido 10 minutos).
2. El programa llama a la Edge Function `emparejar-equipo` con `{ "codigo": "123456" }`.
   Sin sesión previa — es la única llamada que no lleva `Authorization`.
3. La respuesta trae `{ equipoId, nombreEquipo, accessToken, refreshToken }`. El
   programa guarda `equipoId` (lo necesita en el paso 5) e inicia sesión con
   `supabase.auth.setSession({ access_token, refresh_token })` (o el equivalente del
   SDK que use) — queda autenticado como un usuario con **rol `dispositivo_impresion`**
   — nunca ve nada de ventas, gastos, caja, clientes, ni ningún dato financiero (ver
   la auditoría de RLS en `0024_equipos_impresion.sql`).
4. Cada tanto (sugerido: cada 60 segundos) llama al RPC `registrar_latido_equipo()`
   (sin parámetros) para que la interfaz lo muestre "En línea" — se considera
   desconectado a partir de 2 minutos sin latido.
5. Reporta las impresoras que detecta con el RPC `sincronizar_impresoras(p_lista)`
   (Konta Print Bloque 2) -- una sola llamada con TODAS las detectadas en esa pasada,
   no una por una. `p_lista` es un arreglo de
   `{ nombre_sistema, tipo, direccion_red }` (`tipo` es `'local'` o `'red'`;
   `direccion_red` solo si es de red). El equipo se resuelve solo, por la sesión con la
   que se llama -- nunca hace falta mandar `equipo_id`. Crea las impresoras nuevas y
   refresca `ultima_vez_vista` de las que siguen ahí; nunca borra las que desaparecieron
   de la lista (la interfaz las marca "No detectada" y un administrador decide si las
   elimina). Si una impresora fue eliminada desde la web (Bloque 2) y el equipo la
   sigue detectando, esta misma llamada la vuelve a crear sola en la siguiente pasada
   -- es el comportamiento esperado, no un bug.
6. Se suscribe a Postgres Changes de `trabajos_impresion` (ya está en la publicación
   `supabase_realtime`) como señal de "hay algo nuevo, llama a `reclamar_trabajo()`"
   -- el INSERT en sí no trae el payload completo ni las columnas resueltas que
   reclamar_trabajo() sí devuelve, así que no imprime directo desde el evento de
   Realtime.
7. Llama al RPC `reclamar_trabajo()` (sin parámetros) cada vez que Realtime avisa de
   algo nuevo, y también cada tanto por las dudas (sugerido: cada 5-10 segundos,
   como respaldo si se perdió un evento). Devuelve **una fila o ninguna** -- toma
   atómicamente el trabajo `pendiente` más antiguo de ESTE equipo (si hay más de
   uno esperando, hay que seguir llamando hasta que no devuelva filas) y lo deja en
   `estado = 'imprimiendo'`:
   `{ trabajo_id, comandera_id, tipo, payload, nombre_sistema, ancho_papel, copias, cortar_papel }`.
   `nombre_sistema` es el nombre técnico de la impresora de Windows a usar;
   `ancho_papel`/`copias`/`cortar_papel` son los valores ACTUALES de la comandera (no
   los del payload, que puede ser viejo si la comandera se editó después de
   encolarse) -- imprime con estos, no con los del payload.
8. Imprime con esos datos, y llama a `reportar_resultado_trabajo(trabajo_id, ok, detalle)`:
   `ok = true` lo deja en `'impreso'`; `ok = false` con un `detalle` de texto (motivo
   del fallo) lo deja en `'error'`. **Nunca** actualiza `trabajos_impresion` directo
   -- esa vía ya no tiene policy de escritura para este rol, solo existen estos dos
   RPC.
9. Si el programa se cae o pierde la conexión con un trabajo ya en `'imprimiendo'`,
   no hace falta que haga nada especial al reconectar: la próxima llamada de
   CUALQUIER equipo del negocio a `reclamar_trabajo()` devuelve solo a `'pendiente'`
   cualquier trabajo que lleve más de 2 minutos en `'imprimiendo'`, para que se
   pueda reclamar de nuevo.

## Forma exacta del payload

Tabla `trabajos_impresion`, columna `payload` (`jsonb`):

```json
{
  "zona": "Cocina",
  "mesa": "Mesa 4",
  "mesero": "Ana Torres",
  "numero_comanda": 128,
  "fecha_hora": "2026-09-21T14:32:00-05:00",
  "items": [
    { "descripcion": "Pizza lasaña", "cantidad": 2, "nota": "sin cebolla" }
  ],
  "ancho_papel": "80mm",
  "copias": 1,
  "cortar_papel": true
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `zona` | string | Nombre de la zona (`zonas_comanda.nombre`), no el de la comandera. |
| `mesa` | string | Nombre de la mesa. `"Mesa"` genérico si por algún motivo no se pudo resolver. |
| `mesero` | string | Quien abrió la mesa (`ordenes_mesa.abierta_por`), no necesariamente quien hizo clic en "Enviar a cocina". Su nombre fijado en Equipo, o el correo si no lo puso. |
| `numero_comanda` | integer \| null | Correlativo por negocio (`configuracion_impresion.ultimo_numero_comanda`). Comparte número TODA la ronda enviada en una sola llamada a `enviar_comandas_orden` (si esa ronda generó tickets en Cocina y Barra, ambos llevan el mismo número). En una cancelación, es el número de la comanda original a la que pertenecía el ítem. |
| `fecha_hora` | string ISO 8601 con offset | `YYYY-MM-DDTHH:MI:SS±HH:MM`, hora del servidor de Postgres. |
| `items` | array de `{descripcion, cantidad, nota}` | `cantidad` es **positiva** en `tipo="comanda"` y **negativa** en `tipo="cancelacion"`. `nota` es `null` si el ítem no tenía nota (en una cancelación, `nota` lleva el motivo de la cancelación). |
| `ancho_papel` | `"58mm"` \| `"80mm"` | De la comandera (`comanderas.ancho_papel`), no configurable por trabajo. |
| `copias` | integer | De la comandera (`comanderas.copias`). |
| `cortar_papel` | boolean | De la comandera (`comanderas.cortar_papel`). |

**Nunca** aparece `precio_unit`, `subtotal`, `total` ni `metodo_pago` en ningún
lugar del payload — una comanda de cocina no es un comprobante de venta. Si algún
día hiciera falta un dato nuevo, agrégalo como campo opcional (nunca reuses un
nombre existente con otro significado) y actualiza este documento.

## `tipo` y el caso de cancelación

- `"comanda"`: ítems nuevos enviados con `enviar_comandas_orden(p_orden_id)`.
- `"cancelacion"`: se genera automáticamente al cancelar (`cancelar_item_orden_mesa`)
  un ítem que **ya se había enviado** (`comanda_procesada = true`) y solo si
  `configuracion_impresion.imprimir_cancelaciones` está en `true` (por defecto sí).
  Mismo formato exacto que una comanda normal, con `items` de un solo elemento y
  `cantidad` en negativo. Si el ítem cancelado no tenía una zona/comandera activa
  resoluble en ese momento, no se genera ningún trabajo (la cancelación del ítem en
  sí se aplica igual, solo no hay dónde imprimir el aviso).
- `"prueba"`: encolado a mano desde el botón "Probar" de una comandera (Konta Print
  Bloque 3, `probar_comandera(p_comandera_id)`) -- mismo formato exacto (`zona` fija
  en `"Prueba"`, `mesa` en `"Prueba de impresión"`, `mesero` es quien probó, un único
  ítem `"Ticket de prueba -- <nombre de la comandera>"`, `numero_comanda` siempre
  `null`). Se imprime exactamente igual que cualquier otro trabajo, sin tratamiento
  especial de parte del programa.

## `estado` — ciclo de vida

`pendiente` → (`reclamar_trabajo()`) → `imprimiendo` → (`reportar_resultado_trabajo()`)
→ `impreso` **o** `error` (con `error_detalle`). Un trabajo `imprimiendo` que se
queda a medias (el equipo se apagó, perdió conexión) vuelve solo a `pendiente` a los
2 minutos, en la siguiente llamada de cualquier equipo del negocio a
`reclamar_trabajo()` -- ver paso 9 arriba. `/comandas/actividad` (Konta Print
Bloque 6, administrador/contador/cajero) tiene un botón "Reimprimir" que hace lo
mismo a mano para un trabajo `error` o `impreso` (lo vuelve a `pendiente`). Nada
borra filas de `trabajos_impresion` — es historial, igual que `comprobantes`.
`/comandas/central` (mientras Koonta Print no exista) sigue escribiendo `estado`
directo a la tabla para impresoras locales -- tiene su propia policy de
administrador/contador/cajero, separada de la del dispositivo.

## Cómo se decide a qué zona va cada ítem (para entender el origen del payload, no algo que el programa deba resolver)

Prioridad exacta usada por `enviar_comandas_orden` y `cancelar_item_orden_mesa`:

1. Si el producto del ítem tiene un mapeo propio en `mapeo_zona_comanda`
   (`producto_id` = el suyo), usa esa zona.
2. Si no, si la categoría del producto tiene un mapeo (`categoria_id`), usa esa zona.
3. Si no hay ninguno de los dos, el ítem **no genera ningún trabajo** ("sin mapeo, no
   imprime") y queda marcado como procesado igual, para que un mapeo creado después
   nunca lo imprima retroactivamente.
4. Un ítem con `imprimir_comanda = false` tampoco genera trabajo, sin importar su
   mapeo.
5. Un ítem sin `producto_id` (línea libre, sin producto del catálogo) nunca tiene
   categoría que resolver, así que cae siempre en el caso 3.

## Pantalla puente: `/comandas/central`

Mientras Koonta Print no existe, `/comandas/central` (administrador, contador o
cajero) hace lo mismo que hará el programa para impresoras **locales**: escucha
`trabajos_impresion` en vivo, imprime cada uno con `window.print()` en cuanto llega,
y lo marca `impreso`. Sirve como referencia de implementación y como respaldo real
el día que el programa esté desconectado.
