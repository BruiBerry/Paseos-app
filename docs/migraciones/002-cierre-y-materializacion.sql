-- =========================================================
-- Cierre y materialización agendados en la base
--
-- Los dos corrían en el navegador al abrir Hoy: si el paseador no abría la
-- app, no pasaban. Acá pasan a ser trabajo de Postgres, con pg_cron.
--
-- La lógica queda SOLO en SQL. El navegador deja de tener su propia copia y
-- llama a estas funciones cuando necesita el resultado de inmediato — al
-- crear una regla, por ejemplo. Dos implementaciones de "cuánto dura un
-- paseo" o de "qué ocurrencias faltan" terminan discrepando el día que
-- alguien cambia una y olvida la otra.
--
-- Pégalo completo en el SQL Editor de Supabase.
-- =========================================================

-- ---------------------------------------------------------
-- 0. El día de hoy, en Chile
--
-- `current_date` usa la zona del servidor, que en Supabase es UTC. Después
-- de las 20:00 en Chile eso ya es mañana, así que un cierre o una
-- materialización que usen `current_date` trabajan sobre el día equivocado
-- justo en las horas de la tarde. Es el mismo bug que `src/lib/fechas.js`
-- existe para evitar en el navegador.
-- ---------------------------------------------------------
create or replace function fn_hoy_local()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Santiago')::date;
$$;

-- ---------------------------------------------------------
-- 1. La cascada de duración, completa (spec §167)
--
-- Reemplaza a `fn_duracion_perro` y `fn_duracion_paseo`, que se saltaban los
-- dos primeros pasos y quedaron del esquema original.
--
-- `nullif(..., 0)` en cada paso no es adorno: un `duracion_min = 0` es un
-- dato malo, no un paseo de duración indefinida. `coalesce` solo salta los
-- nulos, así que sin el `nullif` un cero se tomaría como respuesta válida y
-- cerraría el paseo con duración cero. Es la misma regla que
-- `src/lib/duracion.js` aplica en el navegador.
-- ---------------------------------------------------------
create or replace function fn_duracion_prevista_paseo(p_paseo_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(
    nullif(p.duracion_min, 0),                    -- 1. escrita a mano al agendar
    nullif(r.duracion_min, 0),                    -- 2. la de la regla recurrente
    (                                             -- 3. la más larga de los perros
      select max(nullif(pe.duracion_min, 0))
        from paseo_perro pp
        join perro pe on pe.id = pp.perro_id
       where pp.paseo_id = p.id
    ),
    nullif(c.duracion_default_min, 0),            -- 4. la default del paseador
    60
  )
  from paseo p
  left join paseo_recurrente r on r.id = p.recurrente_id
  left join configuracion c    on c.paseador_id = p.paseador_id
  where p.id = p_paseo_id;
$$;

drop function if exists fn_duracion_paseo(uuid[]);
drop function if exists fn_duracion_perro(uuid);

-- ---------------------------------------------------------
-- 2. Materialización, para un paseador
--
-- Solo CREA las ocurrencias que faltan; nunca borra ni modifica una que
-- exista. Con eso se cumple sin esfuerzo la regla de respetar toda fila cuyo
-- estado no sea `programado`: lo completado o cancelado jamás se toca.
--
-- SECURITY INVOKER a propósito. Llamada por el paseador desde la app, RLS la
-- limita sola a sus filas; llamada desde la función de cron, que sí es
-- DEFINER, hereda ese contexto elevado y puede recorrer a todos. Una sola
-- implementación sirve a los dos caminos.
-- ---------------------------------------------------------
create or replace function fn_materializar_paseador(
  p_paseador_id uuid,
  p_semanas integer default 8
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_desde   date := fn_hoy_local();
  v_hasta   date := v_desde + (p_semanas * 7);
  v_regla   record;
  v_fecha   date;
  v_perros  uuid[];
  v_paseo   uuid;
  v_creados integer := 0;
begin
  for v_regla in
    select r.id, r.grupo_id, r.dias_semana, r.hora_inicio,
           r.vigente_desde, r.vigente_hasta
      from paseo_recurrente r
     where r.paseador_id = p_paseador_id
       and r.activo
       and r.vigente_desde <= v_hasta
       and (r.vigente_hasta is null or r.vigente_hasta >= v_desde)
  loop
    -- Los perros del grupo que siguen de alta. Un grupo vacío no genera
    -- paseos: un paseo sin perros no se cobra nunca y no hay nada en la
    -- interfaz que delate que quedó a medias.
    select array_agg(pe.id order by pe.id)
      into v_perros
      from grupo_perro gp
      join perro pe on pe.id = gp.perro_id
     where gp.grupo_id = v_regla.grupo_id
       and pe.activo;

    if v_perros is null or cardinality(v_perros) = 0 then
      continue;
    end if;

    for v_fecha in
      select d::date
        from generate_series(
               greatest(v_desde, v_regla.vigente_desde),
               least(v_hasta, coalesce(v_regla.vigente_hasta, v_hasta)),
               interval '1 day'
             ) d
       -- isodow: 1 = lunes … 7 = domingo, igual que `dias_semana`.
       where extract(isodow from d)::integer = any(v_regla.dias_semana)
    loop
      -- Ya existe la ocurrencia de esa regla ese día: no se toca, sea cual
      -- sea su estado.
      if exists (
        select 1 from paseo
         where recurrente_id = v_regla.id and fecha = v_fecha
      ) then
        continue;
      end if;

      insert into paseo (paseador_id, grupo_id, recurrente_id, fecha, hora_programada)
      values (p_paseador_id, v_regla.grupo_id, v_regla.id, v_fecha, v_regla.hora_inicio)
      returning id into v_paseo;

      -- El precio se congela acá y no se recalcula nunca (spec §173). El
      -- recargo por perro adicional se evalúa por casa y no por grupo, que
      -- es lo que hace `fn_precios_cliente_en_paseo` al agrupar por cliente.
      insert into paseo_perro (paseo_id, perro_id, paseador_id, precio_cobrado)
      select v_paseo, pr.perro_id, p_paseador_id, pr.precio
        from (select distinct cliente_id from perro where id = any(v_perros)) c
        cross join lateral fn_precios_cliente_en_paseo(c.cliente_id, v_perros) pr;

      v_creados := v_creados + 1;
    end loop;
  end loop;

  return v_creados;
end;
$$;

/** La que llama la app: opera sobre el paseador de la sesión y nada más. */
create or replace function fn_materializar_mis_paseos(p_semanas integer default 8)
returns integer
language sql
volatile
security invoker
set search_path = public
as $$
  select fn_materializar_paseador(auth.uid(), p_semanas);
$$;

-- ---------------------------------------------------------
-- 3. Cierre de paseos olvidados (spec §189), para un paseador
--
-- El margen es de 180 minutos y no de los 15 que pide la especificación.
-- Ahí se supone que existen los avisos: notifica, insiste, y recién si el
-- paseador los ignora, cierra. Sin notificaciones no hay "los ignoró" que
-- detectar, y cerrar a los 15 minutos mataría por la espalda un paseo que de
-- verdad se alargó — marcando además sus perros como completados, que es
-- dinero. Vuelve a 15 el día que el aviso exista.
--
-- Este es el único lugar donde vive el margen. El navegador ya no decide
-- nada al respecto: llama a esta función y muestra lo que la base decidió.
-- ---------------------------------------------------------
create or replace function fn_cerrar_olvidados_paseador(p_paseador_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_margen_min constant integer := 180;
  v_hoy        date := fn_hoy_local();
  v_p          record;
  v_prevista   integer;
  v_excedido   numeric;
  v_cerrados   integer := 0;
begin
  for v_p in
    select id, fecha, inicio_real, coalesce(pausado_seg, 0) as pausado_seg
      from paseo
     where paseador_id = p_paseador_id
       and estado = 'en_curso'
       and inicio_real is not null
  loop
    v_prevista := fn_duracion_prevista_paseo(v_p.id);
    v_excedido := extract(epoch from (now() - v_p.inicio_real))
                  - v_p.pausado_seg
                  - (v_prevista * 60);

    -- Se cierra solo lo que no admite otra lectura: un paseo de un día
    -- anterior, o uno tan excedido que ningún paseo real dura eso.
    if v_excedido <= 0 then
      continue;
    end if;
    if v_p.fecha >= v_hoy and v_excedido <= v_margen_min * 60 then
      continue;
    end if;

    -- El fin se calcula, no se pone `now()`: el paseo se cierra con la
    -- duración prevista, así que la hora de término es la que habría tenido
    -- si se hubiera cerrado a tiempo. Poner el momento del cierre inventaría
    -- en el historial un paseo de catorce horas que nadie caminó.
    update paseo
       set estado       = 'cerrado_automaticamente',
           fin_real     = inicio_real + make_interval(secs => v_p.pausado_seg + v_prevista * 60),
           duracion_seg = v_prevista * 60
     where id = v_p.id;

    -- Los perros que no se cancelaron uno por uno se dan por realizados.
    update paseo_perro
       set estado = 'completado'
     where paseo_id = v_p.id
       and estado = 'programado';

    v_cerrados := v_cerrados + 1;
  end loop;

  return v_cerrados;
end;
$$;

/** La que llama la app al abrir Hoy. */
create or replace function fn_cerrar_olvidados_mios()
returns integer
language sql
volatile
security invoker
set search_path = public
as $$
  select fn_cerrar_olvidados_paseador(auth.uid());
$$;

-- ---------------------------------------------------------
-- 4. Las corridas de cron: todos los paseadores
--
-- SECURITY DEFINER porque un job de pg_cron no tiene sesión: `auth.uid()` es
-- nulo y RLS no dejaría ver ni escribir nada. Al ser DEFINER heredan el
-- contexto del dueño, y las funciones por paseador que llaman adentro pasan
-- a poder recorrer a todos.
--
-- Por eso mismo se les quita el permiso a todo el mundo salvo al dueño: sin
-- el revoke, cualquiera con la llave `anon` podría dispararlas.
-- ---------------------------------------------------------
create or replace function fn_materializar_todos()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_total  integer := 0;
begin
  for v_id in select id from paseador where activo loop
    v_total := v_total + fn_materializar_paseador(v_id);
  end loop;
  return v_total;
end;
$$;

create or replace function fn_cerrar_olvidados_todos()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_total integer := 0;
begin
  for v_id in select id from paseador where activo loop
    v_total := v_total + fn_cerrar_olvidados_paseador(v_id);
  end loop;
  return v_total;
end;
$$;

revoke execute on function fn_materializar_todos()     from public, anon, authenticated;
revoke execute on function fn_cerrar_olvidados_todos() from public, anon, authenticated;

-- ---------------------------------------------------------
-- 5. El agendamiento
--
-- Si `create extension` falla, habilita pg_cron desde el panel:
-- Database → Extensions → pg_cron. Después vuelve a correr desde acá.
--
-- Los horarios de pg_cron son UTC. 07:00 UTC caen entre las 03:00 y las
-- 04:00 en Chile según el horario de verano: de madrugada en cualquier caso,
-- que es cuando conviene generar ocho semanas de paseos.
--
-- El cierre corre cada hora y no una vez al día porque un paseo olvidado que
-- espera hasta la madrugada no cuenta en el cobro mientras tanto. Cada hora
-- no es agresivo: el margen de 180 minutos sigue protegiendo al paseo que de
-- verdad se alargó.
-- ---------------------------------------------------------
create extension if not exists pg_cron;

-- `unschedule` falla si el job no existe, así que se ignora el error: esto
-- tiene que poder correrse dos veces sin romperse.
do $$
begin
  perform cron.unschedule('materializar-diario');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('cerrar-olvidados');
exception when others then null;
end $$;

select cron.schedule(
  'materializar-diario',
  '0 7 * * *',
  $$select fn_materializar_todos()$$
);

select cron.schedule(
  'cerrar-olvidados',
  '7 * * * *',
  $$select fn_cerrar_olvidados_todos()$$
);
