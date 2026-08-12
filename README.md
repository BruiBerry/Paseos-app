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
  Terminar. Cada hora.

La lógica vive solo en SQL. La app llama a las mismas funciones al abrir Hoy
para ver el efecto de inmediato, pero no depende de eso: aunque nadie abra la
app, los paseos se generan y los olvidados se cierran.

Para ver o cambiar los horarios: `select * from cron.job;`

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

- **Notificaciones push y correos.** Los horarios se guardan en Ajustes,
  pero no se envía nada: necesita trabajo de servidor.
- **Offline completo.** Solo el cronómetro sobrevive sin señal (cola en
  `localStorage`). El resto de las pantallas requiere conexión.
- **Pedir la instalación en el onboarding.** El push en iOS solo llega si la
  app está instalada en la pantalla de inicio, así que pedirlo no puede
  quedar escondido en Ajustes (especificación §6).
- **Layout de escritorio.** Todo está pensado a 480 px de ancho.
