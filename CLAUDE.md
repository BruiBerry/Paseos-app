# Notas para trabajar en este proyecto

PWA de gestión de paseos de perros. React + Vite, Supabase (Postgres con RLS).
Un solo paseador por cuenta; no hay registro público ni portal para clientes.

La especificación de producto está en `docs/app-paseos-especificacion.md` y es
la fuente de verdad para las reglas de negocio. El esquema, en `docs/schema.sql`.
El README explica cómo levantar el proyecto y en qué orden usar las pantallas.

## Estado

Construido y compilando: clientes, perros, grupos con reglas recurrentes,
calendario mensual, cronómetro y cobros. El login ya existía.

Sin construir, en orden de valor: notificaciones push y correos (necesitan
servidor), cierre automático de paseos olvidados, materialización como Edge
Function, offline completo, feed `.ics`, layout de escritorio.

Dos huecos del esquema que bloquean parte de la especificación:

- **La pausa del cronómetro no tiene columna.** Se acumula en `localStorage`
  y se descuenta al cerrar, así que la base guarda la duración ya limpia.
- **No existe `paseo.duracion_min`.** El paso 1 de la cascada de duración
  (escribirla a mano al agendar) no se puede guardar; la cascada parte hoy
  en la regla recurrente.

## Reglas que no se negocian

**Fechas locales, nunca UTC.** `toISOString()` en Chile devuelve el día
siguiente después de las 20:00. Todo pasa por `src/lib/fechas.js`. Este bug
ya estuvo una vez en `Hoy.jsx`.

**El cronómetro no cuenta segundos.** Guarda la hora de inicio y calcula
`ahora − inicio − pausado` en cada despertar. iOS suspende el JavaScript en
segundo plano; un contador que suma de a uno pierde justo el tiempo del paseo.

**Los precios se congelan al crear el paseo** y no se recalculan nunca.
Todo lo que toca dinero pasa por `src/lib/paseos.js`.

**El recargo por perro adicional se cuenta por casa, no por grupo.**

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
nada más. Las funciones puras de `fechas.js` se pueden verificar con
`node --input-type=module`.

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
