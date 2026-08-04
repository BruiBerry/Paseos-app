# App de gestión de paseos de perros

Documento de referencia · 4 de agosto de 2026

---

## 1. Qué es

Una aplicación web instalable (PWA) para que un paseador de perros gestione su agenda, mida la duración real de cada paseo y calcule automáticamente cuánto cobrarle a cada cliente a fin de mes.

Funciona en escritorio y en celular con el mismo código, cambiando solo el layout. En pantalla ancha el calendario muestra la semana completa con horarios reales; en celular se prioriza el flujo de terreno (ver el día, iniciar el cronómetro).

Cada paseador es un usuario independiente con sus propios clientes, perros, grupos y tarifas. Ninguno ve los datos de otro.

---

## 2. Decisiones de arquitectura

| Decisión | Elección | Razón |
|---|---|---|
| Plataforma | PWA instalable | Un solo código para iOS, Android y escritorio |
| Base de datos | Postgres administrado (Supabase) | SQL real para las consultas de facturación; datos portables |
| Aislamiento entre usuarios | Row Level Security de Postgres | El filtro vive en la base, no en el código de la app |
| Funcionamiento sin señal | Escritura local con cola de sincronización | El cronómetro no puede depender de la cobertura |
| Registro de usuarios | Manual, sin registro público | Evita soporte, verificación de correo y recuperación de contraseña |

### Multi-tenancy

Cada fila de las tablas raíz lleva `paseador_id`: `cliente`, `perro`, `grupo`, `paseo_recurrente`, `paseo` y `configuracion`. Las políticas de seguridad de Postgres garantizan que una sesión solo devuelva sus propias filas, incluso si la app tiene un bug.

Esto se construye desde el primer día. Agregar la columna ahora cuesta minutos; migrar tablas con datos reales adentro cuesta un fin de semana.

### Offline

El teléfono escribe primero en una base local y encola los cambios. Cuando vuelve la señal, los envía. Con un usuario por cuenta no existe el problema de dos personas editando lo mismo, así que la sincronización es simple.

El cronómetro **no cuenta segundos con un temporizador**: guarda la hora de inicio y calcula `ahora − inicio_real` cada vez que la pantalla despierta. Esto es obligatorio porque iOS suspende el JavaScript cuando la app no está en primer plano.

---

## 3. Modelo de datos

### `paseador`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `nombre` | string | |
| `email` | string | |
| `activo` | bool | |

### `configuracion`
Una fila por paseador.

| Campo | Tipo | Notas |
|---|---|---|
| `paseador_id` | uuid | FK |
| `tarifa_default` | int | Se usa si el cliente no tiene tarifa propia |
| `recargo_perro_adicional` | int | Puede ser 0 |
| `duracion_default_min` | int | 60 |
| `radio_geocerca_m` | int | ~100 |
| `hora_resumen_diario` | time | 7:30 |
| `minutos_aviso_previo` | int | 30 |

### `cliente`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id` | uuid | FK |
| `nombre`, `telefono`, `email` | string | |
| `direccion` | string | |
| `lat`, `lng` | float | Para la detección de proximidad |
| `tarifa_paseo` | int | **Nullable** — precio del primer perro de la casa en un paseo; si es null usa `tarifa_default` |
| `tarifa_perro_adicional` | int | **Nullable** — precio del segundo perro de la misma casa en adelante, en el mismo paseo; si es null usa `recargo_perro_adicional` |
| `notas_acceso` | string | Código de portón, dónde está la llave |
| `activo` | bool | No se borra, se desactiva |

### `perro`
| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id`, `cliente_id` | uuid | FK |
| `nombre` | string | |
| `duracion_min` | int | **Nullable** — si es null usa `duracion_default_min` |
| `color_hex` | string | |
| `notas` | string | Temperamento, medicamentos |
| `activo` | bool | |

### `grupo`
Un conjunto de perros que se pasean juntos, típicamente de la misma zona.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id` | uuid | FK |
| `nombre` | string | Ej. "Los Militares" |
| `color_hex` | string | Es el color que usa el calendario |
| `zona` | string | |

### `grupo_perro`
| Campo | Tipo |
|---|---|
| `grupo_id` | uuid FK |
| `perro_id` | uuid FK |

### `paseo_recurrente`
La **regla**, no los eventos.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id`, `grupo_id` | uuid | FK |
| `dias_semana` | int[] | Ej. `[1,3,5]` |
| `hora_inicio` | time | |
| `duracion_min` | int | Nullable |
| `vigente_desde`, `vigente_hasta` | date | `hasta` nullable = indefinido |
| `activo` | bool | |

### `paseo`
La **ocurrencia concreta**. No tiene `cliente_id` ni precio: un paseo puede incluir perros de varios dueños.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id` | uuid | FK |
| `grupo_id` | uuid | FK, nullable (paseo suelto) |
| `recurrente_id` | uuid | FK, nullable (esporádico) |
| `fecha` | date | |
| `hora_programada` | time | |
| `estado` | enum | `programado`, `en_curso`, `completado`, `cancelado`, `cerrado_automaticamente` |
| `inicio_real`, `fin_real` | timestamp | |
| `duracion_seg` | int | Calculada y guardada |
| `inicio_automatico` | bool | Si lo gatilló la proximidad por GPS |
| `notas` | string | |

### `paseo_perro`
Aquí vive el dinero. Una fila por perro por paseo.

| Campo | Tipo | Notas |
|---|---|---|
| `paseo_id`, `perro_id` | uuid | FK |
| `precio_cobrado` | int | **Congelado** al crear la fila |
| `se_cobra` | bool | Refleja el estado: solo se cobra si el paseo se realizó |
| `estado` | enum | Permite que falte un solo perro sin cancelar el paseo |
| `motivo_cancelacion` | string | |

### `cobro`
El equivalente a una boleta mensual.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK |
| `paseador_id`, `cliente_id` | uuid | FK |
| `periodo` | string | `2026-07` |
| `monto` | int | |
| `estado` | enum | `pendiente`, `cobrado` |
| `fecha_pago` | date | |

---

## 4. Reglas de negocio

### Cascada de tarifa
1. Tarifa propia del cliente (`tarifa_paseo`), si no `tarifa_default` de la configuración del paseador
2. Si el mismo cliente lleva más de un perro **en el mismo paseo**, el primero paga la tarifa completa y los siguientes pagan `tarifa_perro_adicional` del cliente (o `recargo_perro_adicional` de la configuración si no está definida)
3. **El recargo se calcula por casa, no por grupo.** Si un paseo de grupo mezcla perros de varios clientes, cada cliente se evalúa por separado según cuántos perros suyos van en ese paseo — a un cliente con un solo perro en el grupo no le afecta que el grupo tenga cuatro perros en total

### Cascada de duración
1. Duración escrita a mano al agendar ese paseo
2. Si no, la de la regla recurrente
3. Si no, **la duración más larga entre los perros que participan** (no se puede pasear a uno 45 min y a otro 60 al mismo tiempo)
4. Si no, `duracion_default_min`

### Congelamiento de precio
`precio_cobrado` se copia en `paseo_perro` en el momento de crear la fila y nunca se recalcula. Subir la tarifa en agosto no debe cambiar retroactivamente lo cobrado en julio.

### Materialización de recurrentes
Un proceso diario genera filas reales de `paseo` manteniendo un horizonte de **8 semanas** hacia adelante a partir de las reglas activas.

Al regenerar tras un cambio de regla, **se respeta cualquier fila cuyo estado no sea `programado`**. Lo ya completado o cancelado no se toca.

La alternativa —calcular las ocurrencias al vuelo— se descartó: obliga a una tabla de excepciones aparte y convierte cada consulta del calendario y cada cierre de mes en un cálculo de recurrencias.

### Cálculo del precio al crear un paseo
Al generar las filas de `paseo_perro` para un paseo (sea de grupo o suelto), los perros se agrupan por `cliente_id`. Dentro de cada grupo de un mismo cliente, el primer perro recibe `tarifa_paseo` y los siguientes reciben `tarifa_perro_adicional`. El resultado se congela en `precio_cobrado` como siempre.

### Nada se borra
Cancelar cambia el `estado`. Dar de baja un cliente lo marca `activo = false`. El historial queda íntegro.

### Cierre automático de paseos olvidados
Si un cronómetro supera la duración prevista en 15 minutos, se envía un aviso. Si se ignora, insiste una vez más y luego cierra el paseo con la duración prevista, marcándolo `cerrado_automaticamente` para revisión.

---

## 5. Pantallas

### Hoy
Pantalla de inicio. Lista de paseos del día en orden, con la duración prevista a la derecha. **No muestra precios**: son un dato de facturación que se calcula solo.

- Los cancelados se quedan visibles, atenuados y tachados
- El pie muestra paseos pendientes y tiempo restante del día
- Si el GPS detecta que estás dentro del radio de una casa con paseo pendiente, aparece una tarjeta con el botón de iniciar ya precargado; el resto del día no ocupa espacio

### Cronómetro activo
Tiempo grande en fuente monoespaciada, barra de progreso contra la duración prevista, botones de pausar y terminar. Indicador visible de "sin conexión, se guardará después" como confirmación, no como error.

La pausa existe para el tiempo real de entrar a la casa, dejar al perro y llenar el agua.

### Calendario
Vista mensual con puntos de color **por grupo**, no por perro. Con 12 perros los colores por perro dejan de ser distinguibles; los grupos son menos y el punto además significa algo útil.

- Máximo 4 puntos por celda, luego un `+N` discreto
- No muestra horarios: responde "¿cómo viene el jueves?"; el detalle baja al tocar el día
- En escritorio, vista semanal con horarios reales y lista del día al costado

### Clientes
Lista y ficha con datos, perros, tarifa, dirección y notas de acceso.

### Cobros
Abre en el mes **cerrado**, no en el actual.

- Dos cifras: total del mes y total por cobrar
- Ordenado por pendiente primero; lo cobrado baja y se atenúa
- Alerta visible de clientes que están usando la tarifa por defecto (es el punto donde se atrapa el error de haber olvidado configurar una tarifa)
- El detalle por cliente lista cada paseo con su duración real y su monto; lo cancelado no se cobra y se ve atenuado con el motivo escrito
- Compartir usa el menú nativo del sistema (WhatsApp, correo)

### Ajustes
Tarifa y duración por defecto, recargo por perro adicional, horarios de aviso, radio de geocerca, token del feed de calendario.

---

## 6. Notificaciones

Regla base: **una notificación tiene que ser accionable o no existir.**

| Aviso | Canal | Cuándo |
|---|---|---|
| Resumen del día | Push | 7:30, incluye la hora estimada de término |
| Paseo próximo | Push | 30 min antes, con la dirección en el cuerpo |
| Cronómetro sin cerrar | Push | Duración prevista + 15 min |
| Resumen semanal | Correo | **Domingo 20:00** |
| Cierre de mes listo | Correo | Día 1 del mes siguiente |

### Reglas de silencio
- Si no hay paseos ese día, no se envía nada
- Si el paseo ya se inició, el recordatorio se cancela solo
- Dos paseos a menos de 45 minutos se agrupan en un solo aviso

### Resumen semanal
Se envía el domingo en la noche, no el lunes en la mañana: si llega el lunes a las 7:00 ya es tarde para reagendar el paseo de las 9:00.

El asunto lleva la información completa (`Tu semana: 14 paseos, $98.000`). El cuerpo tiene el desglose por día y un bloque de "necesita tu atención" con choques de horario y clientes sin tarifa configurada.

Detectar choques implica comparar paseos superpuestos **considerando el traslado entre direcciones**, no solo las horas.

### Restricción de iOS
El push en iOS funciona **únicamente si la app está instalada en la pantalla de inicio**. En una pestaña de Safari no llega nada. Por eso el onboarding debe pedir la instalación de forma explícita, con instrucciones separadas para iOS y Android, y no esconderlo en Ajustes.

---

## 7. Feed de calendario

La app publica una URL `.ics` que el paseador suscribe una vez en el calendario de su teléfono. Los paseos aparecen como eventos nativos junto al resto de su agenda.

- Cada evento lleva título (grupo y cantidad de perros), dirección como ubicación, duración calculada y alarma previa
- La generación es una consulta directa a `paseo` por rango de fechas: otro dividendo de haber materializado las ocurrencias
- **La URL es la contraseña**: token largo y aleatorio, nunca el id del paseador, y regenerable desde Ajustes

### Limitación que define su rol
La frecuencia de actualización la decide el teléfono, no el servidor. iOS refresca los calendarios suscritos cuando le parece y no hay forma de forzarlo. Si un cliente cancela a las 8:00 el paseo de las 9:00, el calendario puede seguir mostrándolo.

El feed sirve para **planificar**; el push sirve para **lo que cambió hoy**. Se complementan, no se reemplazan.

### Nota de privacidad
Poner códigos de portón y ubicación de llaves en las notas del evento es cómodo, pero saca datos de acceso a casas ajenas hacia el calendario del teléfono y su respaldo en la nube. Debe ser una opción apagada por defecto, con las notas sensibles visibles solo dentro de la app.

---

## 8. Lo que la app no hace

Vale la pena tenerlo escrito para no descubrirlo a mitad de camino.

- **No inicia el paseo sola al llegar.** No existe geofencing en segundo plano en una PWA: iOS suspende el JavaScript y la API de geofencing del navegador fue abandonada por Chrome. Lo que hay es detección de proximidad al abrir la app, que reduce el inicio a un toque. El automático real requiere empaquetar la misma web en Capacitor y publicarla como app nativa, lo que se puede hacer después sin rehacer nada.
- **No cobra ni procesa pagos.** Registra montos y marca si entraron.
- **No tiene portal para clientes.** Solo el paseador entra.
- **No maneja empleados.** Cada paseador es una cuenta independiente con su propia cartera; no hay liquidación de comisiones ni sueldos.

---

## 9. Decisiones tomadas por defecto

Están implementadas así salvo indicación contraria:

- Varios perros del mismo cliente en un mismo paseo: tarifa completa al primero, `tarifa_perro_adicional` a los siguientes. Se calcula por casa, no por grupo
- Cancelación del paseo, por el motivo que sea: no se cobra. Solo se cobra lo efectivamente realizado
- Estado de cobro (`pendiente` / `cobrado`): no estaba en los requerimientos originales, se agregó porque el trabajo no termina al calcular el total sino cuando la plata llega

---

## 10. Pendiente de definir

- Marca, nombre y dominio
- Si la app pasa de prueba entre conocidos a algo abierto, revisar el estado de la normativa chilena de protección de datos personales, que se actualizó recientemente

---

## 11. Orden sugerido de construcción

1. Esquema de base de datos completo con las políticas de seguridad por fila
2. Alta de clientes, perros y grupos, y la pantalla de configuración
3. Pantalla Hoy y cronómetro, con funcionamiento sin señal
4. Materialización de paseos recurrentes y calendario
5. Cobros y detalle por cliente
6. Feed de calendario (barato y resuelve buena parte del problema de avisos)
7. Notificaciones push y correos
8. Detección de proximidad por GPS
9. Layout de escritorio

El orden pone primero lo que hace que la app sea usable un día cualquiera y deja para el final lo que ahorra toques.
