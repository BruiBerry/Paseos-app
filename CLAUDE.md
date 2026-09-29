# Notas para trabajar en este proyecto

PWA de gestión de paseos de perros. React + Vite, Supabase (Postgres con RLS).
Un solo paseador por cuenta; no hay registro público ni portal para clientes.

La especificación de producto está en `docs/app-paseos-especificacion.md` y es
la fuente de verdad para las reglas de negocio. El esquema, en `docs/schema.sql`.
El README explica cómo levantar el proyecto y en qué orden usar las pantallas.

## Estado

Construido y compilando: clientes, perros, grupos con reglas recurrentes,
calendario mensual, cronómetro y cobros. El login ya existía.

La cascada de duración está completa desde que se agregaron
`paseo.duracion_min` y `paseo.pausado_seg` (11 de agosto de 2026). Los dos
huecos del esquema que bloqueaban parte de la especificación ya no existen.

Notificaciones push: escrito el primer corte (aviso de paseo sin cerrar,
migración 004), pendiente de activar en Supabase y Vercel — los pasos están
en el README. Sin construir, en orden de valor: el resto de las
notificaciones (resumen del día, paseo próximo, correos), offline completo,
pedir la instalación en el onboarding, layout de escritorio.

**El cierre y la materialización corren en la base, con `pg_cron`.** El
cierre cada 5 minutos, la materialización a las 07:00 UTC. La lógica vive solo en
SQL; el navegador llama a las mismas funciones por RPC al abrir Hoy, para ver
el efecto de inmediato en vez de esperar la próxima corrida. Las funciones
`_todos` son SECURITY DEFINER —un job de cron no tiene `auth.uid()`— y
tienen el execute revocado de `anon` y `authenticated`.

El despliegue es Vercel, conectado a `main`: cada push publica. `vercel.json`
tiene el rewrite de SPA, sin el cual recargar en `/paseo/:id` daría 404, y
saca del caché a `sw.js` para que la PWA pueda actualizarse sola. El rewrite
excluye `/api`, que si no se tragaría el feed.

Los cambios de esquema posteriores al inicial van en `docs/migraciones/`,
numerados, y se ejecutan a mano en el editor SQL de Supabase.

**La llave `service_role` no sale de Supabase.** El feed `.ics` lo pide una
app de calendario sin sesión posible, y la salida fácil habría sido darle esa
llave al servidor. En vez de eso, `fn_agenda_por_token` es SECURITY DEFINER y
valida el token adentro, así que a `api/calendario/[token].js` le basta la
llave `anon` que ya es pública. Si algún día hace falta algo parecido, este es
el patrón: función SECURITY DEFINER con su propio secreto, no una llave que se
salta RLS viajando fuera.

**La materialización corre en el cliente**, al abrir Hoy, una vez al día
(`materializarUnaVezAlDia`). Si el paseador no abre la app, no se generan
paseos. El horizonte de 8 semanas da colchón de sobra, pero es la razón por
la que la especificación la quiere como proceso diario del servidor.

## Reglas que no se negocian

**Fechas locales, nunca UTC.** `toISOString()` en Chile devuelve el día
siguiente después de las 20:00. Todo pasa por `src/lib/fechas.js`. Este bug
ya estuvo una vez en `Hoy.jsx`.

**El cronómetro no cuenta segundos.** Guarda la hora de inicio y calcula
`ahora − inicio − pausado` en cada despertar. iOS suspende el JavaScript en
segundo plano; un contador que suma de a uno pierde justo el tiempo del paseo.

**La pausa se escribe al reanudar, no al pausar,** y como total absoluto, no
como incremento: la cola reintenta, y sumar dos veces inflaría la pausa y
acortaría el paseo. `duracion_seg` va limpia y `pausado_seg` aparte, para
poder explicar después por qué el reloj no cuadra con `fin_real − inicio_real`.
`localStorage` quedó como espejo y le gana a la base al leer, porque sin señal
la escritura queda encolada y la base todavía tiene el total anterior.

**Los precios se congelan al crear el paseo** y no se recalculan nunca.
Todo lo que toca dinero pasa por `src/lib/paseos.js`.

**El recargo por perro adicional se cuenta por casa, no por grupo.**

**El cierre automático espera a que el aviso se haya entregado; si no, usa
180 minutos.** La spec supone que existen los avisos: notifica, insiste, y
recién entonces cierra. Sin notificaciones no hay "los ignoró" que detectar,
y cerrar a los 15 minutos mataría por la espalda un paseo que de verdad se
alargó — y de paso marcaría los perros como completados, que es dinero. La
escalera es prevista+15 primer aviso, +30 segundo, y 15 minutos después del
segundo se cierra, pero solo si `paseo.aviso_olvido_2_en` está marcado, y eso
ocurre únicamente cuando algún dispositivo recibió el push. Sin suscripción
activa, o con el servicio de push caído, rige el margen de 180. Los números
(15, 30, 15, 180) viven en SQL, repetidos entre `fn_avisos_pendientes` y
`fn_cerrar_olvidados_paseador`: si cambias uno, cambia el otro.

**El servidor de push no toma decisiones.** `api/push/enviar.js` firma con
VAPID y envía lo que `fn_avisos_pendientes` le devuelve. Es SECURITY DEFINER
con el secreto de la tabla `secreto_servidor` —mismo patrón que el feed—; el
secreto no está en el entorno de Vercel y `service_role` sigue sin salir de
Supabase. Una suscripción caducada (404/410) queda `activa = false`, no se
borra.

**Nada se borra.** Cancelar cambia el estado; dar de baja marca
`activo = false`. La única excepción escrita a propósito: al pausar una regla
recurrente se borran sus ocurrencias futuras que siguen en `programado`.

**Todo insert lleva `paseador_id` explícito.** El esquema no le pone default;
la política de RLS sí lo valida. Sale de `useSesion()`.

## Trampas conocidas

**Los selects de PostgREST van sin espacios.** El parser rechaza el blanco
entre un paréntesis de cierre y el siguiente, así que un embed anidado
indentado devuelve 400 — en tiempo de ejecución, no al compilar. Esto ya
rompió tres consultas una vez.

**Verifica las consultas contra la base antes de darlas por buenas.** Con la
llave `anon` basta: RLS devuelve vacío, pero un embed mal escrito devuelve 400.

```bash
set -a && . ./.env && set +a
curl -s -G "$VITE_SUPABASE_URL/rest/v1/paseo" \
  --data-urlencode "select=id,fecha,grupo(id,nombre)" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -w "\n%{http_code}\n"
```

**No hay tests.** `npm run build` atrapa los errores de sintaxis y de import,
nada más. Los módulos puros —`fechas.js`, `duracion.js`, `ics.js`, y
`cierrePorOlvido` de `paseos.js`— se pueden verificar con `node`, y por eso
están separados de todo lo que toca la red. Al escribir esas pruebas en la
línea de comandos, ojo con las barras invertidas: pasan por bash y por JS, y
una prueba del escapado de `.ics` puede fallar por el shell y no por el código.

**La cascada de duración está escrita dos veces, a propósito.** En
`src/lib/duracion.js` para el navegador y en `fn_duracion_prevista_paseo`
para la base, porque el cierre agendado corre sin navegador y tiene que
calcularla en SQL. Es la única duplicación deliberada del proyecto: si
cambias una, cambia la otra. Ojo con el cero — en SQL hay que escribir
`nullif(x, 0)` en cada paso, porque `coalesce` solo salta los nulos y un
`duracion_min = 0` cerraría el paseo con duración cero.

**La cascada de duración vive en `duracion.js`, no en `paseos.js`.** La
comparten el navegador y la función de servidor del feed; `paseos.js` importa
el cliente de Supabase y no carga fuera de Vite. `paseos.js` la reexporta,
así que las pantallas no notan la diferencia. `ics.js` importa con extensión
`.js` explícita porque corre en Node, donde no hay resolución al estilo Vite.

## Convenciones

Código, nombres y comentarios en español, igual que el esquema y la interfaz.
Los estados de carga son `'cargando' | 'ok' | 'error'`.

Los estilos compartidos viven en `src/estilos.css` con clases en español
(`.tarjeta`, `.fila`, `.boton`, `.micro`). Los `style` en línea quedan para
ajustes de una sola vez.

Los comentarios explican **por qué**, no qué. Si algo parece innecesariamente
raro, casi siempre hay una restricción detrás — escríbela.

La app está pensada a 480 px de ancho: es una herramienta de terreno que se
usa con una mano, parado en la calle.
