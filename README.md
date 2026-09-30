# Paseos

PWA para gestionar paseos de perros: agenda, cronómetro y cobro mensual.
Backend en Supabase (Postgres con Row Level Security).

La especificación completa está en [docs/app-paseos-especificacion.md](docs/app-paseos-especificacion.md)
y el esquema en [docs/schema.sql](docs/schema.sql).

## Poner en marcha

1. `npm install`

2. Crea `.env` con los dos valores del panel de Supabase
   (**Project Settings → API**):

   ```
   VITE_SUPABASE_URL=…      # "Project URL"
   VITE_SUPABASE_ANON_KEY=… # "anon public"
   ```

   Nunca uses la llave `service_role` acá: esa se salta RLS y no debe
   llegar nunca al navegador.

3. `npm run dev` y abre `http://localhost:5173`.

Los usuarios se crean a mano en **Authentication → Users**. Un trigger
(`fn_nuevo_paseador`) les arma la fila en `paseador` y su `configuracion`
con valores por defecto, así que la cuenta queda lista sin pasos extra.

El esquema inicial es [docs/schema.sql](docs/schema.sql). Los cambios
posteriores viven en [docs/migraciones/](docs/migraciones/), numerados, y se
ejecutan a mano en el editor SQL de Supabase. `schema.sql` se mantiene al día
para que siempre refleje la base real.

## Despliegue

Está en Vercel, conectado a `main`: cada push publica. Las dos variables
`VITE_*` se configuran en el panel del proyecto — se incrustan al compilar,
así que agregarlas después obliga a un *Redeploy*.

`vercel.json` hace dos cosas que no son opcionales: el rewrite que manda todo
a `index.html` (sin él, recargar en `/paseo/:id` da 404, que en una PWA
instalada es fatal) excluyendo `/api`, y sacar `sw.js` del caché para que el
service worker pueda actualizarse.

La llave `anon` termina incrustada en el JavaScript público. Es su diseño:
quien protege los datos es RLS, no el secreto de la llave.

## Procesos agendados

Dos cosas corren solas dentro de Postgres, con `pg_cron`:

- **Materializar** las reglas recurrentes en filas reales de `paseo`,
  manteniendo 8 semanas hacia adelante. Diaria, 07:00 UTC (madrugada en Chile).
- **Cerrar** los paseos que quedaron `en_curso` porque se olvidó apretar
  Terminar. Cada 5 minutos.

Y un tercero llama al servidor de Vercel: **enviar avisos** push, cada 5
minutos (ver "Notificaciones push" más abajo).

La lógica vive solo en SQL. La app llama a las mismas funciones al abrir Hoy
para ver el efecto de inmediato, pero no depende de eso: aunque nadie abra la
app, los paseos se generan y los olvidados se cierran.

Para ver o cambiar los horarios: `select * from cron.job;`

## Notificaciones push

Hay dos avisos.

**Paseo próximo.** Un push `minutos_aviso_previo` antes del paseo (Ajustes,
30 por defecto), con las direcciones en el cuerpo. Los paseos ya iniciados,
cancelados o sin perros no avisan. Si entre el fin previsto de un paseo y el
inicio del siguiente hay menos de 45 minutos, van en un solo aviso que los
nombra a todos. Las notas de acceso nunca van en el push: quedan en la
pantalla de bloqueo. Migración `005`.

**Resumen del día.** Un push a `hora_resumen_diario` (Ajustes, 7:30 por defecto)
con cuántos paseos hay y a qué hora termina el día. Sin paseos, no se envía.
Sale una vez al día y solo durante las 2 horas siguientes a esa hora. No lleva
direcciones. Migración `006`.

**Paseo sin cerrar.** Un paseo que pasa 15 minutos
de su duración recibe un aviso; a los 30, un segundo; y 15 minutos después del
segundo se cierra solo. El cierre a 15 minutos solo vale si el segundo aviso
*se entregó*: sin push activo, o con el servicio caído, sigue rigiendo el
margen de 180 minutos.

Qué avisar lo decide SQL (`fn_avisos_pendientes`); `api/push/enviar.js` solo
firma con VAPID y envía. El cron lo llama con `pg_net`, mandando un secreto
que vive únicamente en la tabla `secreto_servidor`.

Para ponerlo en marcha, en este orden:

1. `npx web-push generate-vapid-keys`. La pública va en `VAPID_PUBLIC_KEY`
   y la privada en `VAPID_PRIVATE_KEY`, las dos en las variables de entorno de
   Vercel, junto a `VAPID_SUBJECT` (`mailto:tu-correo`). Redeploy.
2. Habilita `pg_net` en Supabase (Database → Extensions).
3. Ejecuta `docs/migraciones/004-notificaciones-push.sql`. Crea la tabla
   `secreto_servidor`; el job de avisos falla en silencio hasta el paso 4.
4. Carga los secretos, con un secreto generado por ti (`crypto.randomBytes`):
   `insert into secreto_servidor (nombre, valor) values ('push', '…'),
   ('push_url', 'https://TU-APP.vercel.app/api/push/enviar')
   on conflict (nombre) do update set valor = excluded.valor;`
   Después de la 004, ejecuta también la `005` (paseo próximo) y la `006`
   (resumen del día).
5. En el teléfono, abre la app instalada → Ajustes → Notificaciones y actívalas.

Para probar un dispositivo sin esperar un paseo atrasado:

```bash
curl -X POST "https://TU-APP.vercel.app/api/push/enviar?prueba=1" \
  -H "Authorization: Bearer EL_SECRETO"
```

Si algo no llega, `select * from cron.job_run_details order by start_time
desc limit 10;` muestra si el job corrió, y `select * from
net._http_response order by created desc limit 5;` qué respondió Vercel.

## Feed de calendario

`/api/calendario/<token>` publica la agenda como `.ics` para suscribirla en
el calendario del teléfono. La dirección se saca de Ajustes.

**La URL es la contraseña**: no pide sesión, así que quien la tenga ve la
agenda. Es regenerable desde la misma pantalla.

Lo pide una app de calendario, que no puede autenticarse, así que la consulta
pasa por `fn_agenda_por_token` — SECURITY DEFINER, valida el token dentro de
la base. Por eso al servidor le basta la llave `anon` y la `service_role`
nunca sale de Supabase.

## Cómo empezar a usarla

El orden importa: los paseos cuelgan de los grupos, y los grupos de los perros.

1. **Ajustes** — revisa tarifa por defecto, recargo por perro adicional y
   duración por defecto. Todo lo demás cae en cascada desde acá.
2. **Clientes** — crea el cliente, y dentro de su ficha sus perros. La
   tarifa propia y la duración propia son opcionales: vacías usan la
   default.
3. **Clientes → pestaña Grupos** — crea un grupo, elígele perros y dale
   una o más reglas recurrentes (qué días, a qué hora). Al guardar una
   regla se generan de inmediato las próximas 8 semanas de paseos.
4. **Calendario** — los puntos de color son grupos. Toca un día para ver
   el detalle o agendar un paseo suelto.
5. **Hoy** — la lista del día. Toca un paseo para abrir el cronómetro.
6. **Cobros** — abre en el último mes cerrado, no en el actual.

## Estructura

```
src/lib/
  sesion.jsx      contexto: sesión, paseador_id y configuración
  paseos.js       crear paseo, congelar precios, iniciar/terminar/cancelar
  recurrentes.js  materialización de las reglas a filas de `paseo`
  consultas.js    el select compartido de un paseo con todo lo que cuelga
  cola.js         reintento de escrituras del cronómetro sin señal
  fechas.js       fechas locales, periodos de cobro, formato de duración
  geo.js          distancia y ubicación para la detección de proximidad
src/pages/        una pantalla por archivo
```

## Decisiones que conviene conocer antes de tocar el código

**Las fechas son locales, nunca UTC.** `toISOString()` en Chile devuelve el
día siguiente después de las 20:00. Todo pasa por `src/lib/fechas.js`.

**El cronómetro no cuenta segundos.** Guarda la hora de inicio y calcula
`ahora − inicio − pausado` cada vez que la pantalla despierta. iOS suspende
el JavaScript en segundo plano, así que cualquier contador que sume de a uno
pierde justo el tiempo del paseo.

**Los precios se congelan al crear el paseo.** `paseo_perro.precio_cobrado`
se calcula con `fn_precios_cliente_en_paseo` y no se recalcula nunca: subir
la tarifa en agosto no cambia lo cobrado en julio.

**El recargo por perro adicional se cuenta por casa, no por grupo.** A quien
lleva un solo perro no le afecta que el grupo tenga cuatro.

**Los selects de PostgREST van sin espacios.** El parser rechaza el blanco
entre un paréntesis de cierre y el siguiente, así que indentar un embed
anidado devuelve 400 en tiempo de ejecución, no al compilar.

**Nada se borra.** Cancelar cambia el estado; dar de baja marca
`activo = false`.

## Qué falta

- **Resto de las notificaciones.** Faltan los dos correos (resumen semanal y
  cierre de mes).
  La base de push ya existe: cada aviso nuevo es una función SQL más.
- **Offline completo.** Solo el cronómetro sobrevive sin señal (cola en
  `localStorage`). El resto de las pantallas requiere conexión.
- **Pedir la instalación en el onboarding.** El push en iOS solo llega si la
  app está instalada en la pantalla de inicio, así que pedirlo no puede
  quedar escondido en Ajustes (especificación §6).
- **Layout de escritorio.** Todo está pensado a 480 px de ancho.
