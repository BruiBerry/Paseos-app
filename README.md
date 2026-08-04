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
- **Cierre automático de paseos olvidados.** Hoy el cronómetro solo avisa
  en pantalla que se pasó de la duración prevista.
- **Materialización como Edge Function.** Corre en el navegador al abrir la
  app, una vez al día. La lógica de `src/lib/recurrentes.js` se mueve tal cual.
- **Offline completo.** Solo el cronómetro sobrevive sin señal (cola en
  `localStorage`). El resto de las pantallas requiere conexión.
- **Feed `.ics`.** El esquema todavía no tiene columna para el token.
- **`paseo.duracion_min`.** La especificación permite escribir a mano la
  duración al agendar un paseo, pero no hay dónde guardarla: la cascada parte
  hoy en la regla recurrente.
- **Layout de escritorio.** Todo está pensado a 480 px de ancho.
