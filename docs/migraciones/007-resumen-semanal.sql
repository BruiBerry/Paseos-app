-- =========================================================
-- Resumen semanal por correo — spec §6
--
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo, después de la
-- 006. Se puede correr dos veces sin romperse.
--
-- Reglas de la especificación:
--   · Correo el domingo a las 20:00, con la semana que empieza al día
--     siguiente: el lunes a las 7:00 ya es tarde para reagendar las 9:00.
--   · El asunto lleva el total (`Tu semana: 14 paseos, $98.000`); el cuerpo,
--     el desglose por día y un bloque "necesita tu atención".
--
-- Decisiones propias, que la especificación no fija:
--   · Un choque es solo de horas superpuestas, sin estimar el traslado entre
--     casas. La especificación pide considerarlo, pero se prefirió que el
--     correo sea un orden claro de la semana y no una estimación de rutas.
--   · Sin paseos esa semana no se envía nada: un correo vacío no es
--     accionable.
--   · Sale una vez por semana y solo durante las 3 horas siguientes a las
--     20:00. Si el cron estuvo caído toda la ventana, esa semana no hay
--     correo.
--
-- Esta función solo decide a quién y con qué datos. El texto del correo y
-- el envío viven en `api/correo/enviar.js`, igual que el push. El secreto es
-- el mismo de la 004 (`secreto_servidor.nombre = 'push'`).
-- =========================================================

-- Marca de "ya enviado": el domingo en que se mandó, como fecha local, igual
-- que `resumen_enviado_el` de la 006.
alter table configuracion
  add column if not exists resumen_semanal_enviado_el date;

-- ---------------------------------------------------------
-- 1. Los correos semanales pendientes
--
-- Solo cuenta paseos `programado` con algún perro `programado`, como el
-- resumen del día. El monto suma `precio_cobrado` de esos perros que se
-- cobran: el precio congelado, nunca recalculado.
--
-- Los choques comparan `fecha + hora_programada` contra su fin previsto, los
-- dos en hora local y sin convertir: se comparan entre sí y no contra
-- `now()`, así que `at time zone` no hace falta (y el cambio de horario no
-- cae en un paseo normal).
--
-- "Sin tarifa" usa la misma definición que la pantalla de cobros: el cliente
-- tiene `tarifa_paseo` nula y algo que cobrar.
-- ---------------------------------------------------------
create or replace function fn_correos_semanales_pendientes()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ventana_min constant integer := 180;
  v_zona        constant text := 'America/Santiago';
  v_hoy         date := fn_hoy_local();
  v_desde       date := fn_hoy_local() + 1;
  v_hasta       date := fn_hoy_local() + 7;
  v_inicio      timestamptz := (fn_hoy_local() + time '20:00') at time zone v_zona;
  v_correos     jsonb;
begin
  -- 0 = domingo
  if extract(dow from v_hoy) <> 0
     or now() < v_inicio
     or now() >= v_inicio + v_ventana_min * interval '1 minute' then
    return '[]'::jsonb;
  end if;

  with base as (
    select p.id, p.paseador_id, p.fecha, p.hora_programada,
           coalesce(g.nombre, 'Paseo') as grupo,
           p.fecha + p.hora_programada as inicio_local,
           p.fecha + p.hora_programada
             + fn_duracion_prevista_paseo(p.id) * interval '1 minute' as fin_local
      from paseo p
      left join grupo g on g.id = p.grupo_id
     where p.estado = 'programado'
       and p.fecha between v_desde and v_hasta
       and exists (select 1 from paseo_perro pp
                    where pp.paseo_id = p.id and pp.estado = 'programado')
  ),
  detalle as (
    select b.*,
           (select coalesce(jsonb_agg(pe.nombre order by pe.nombre), '[]'::jsonb)
              from paseo_perro pp
              join perro pe on pe.id = pp.perro_id
             where pp.paseo_id = b.id and pp.estado = 'programado') as perros,
           (select coalesce(sum(pp.precio_cobrado) filter (where pp.se_cobra), 0)
              from paseo_perro pp
             where pp.paseo_id = b.id and pp.estado = 'programado') as monto
      from base b
  ),
  totales as (
    select d.paseador_id,
           count(*) as n,
           sum(d.monto) as monto,
           jsonb_agg(jsonb_build_object(
             'fecha', d.fecha,
             'hora',  to_char(d.hora_programada, 'HH24:MI'),
             'fin',   to_char(d.fin_local, 'HH24:MI'),
             'grupo', d.grupo,
             'perros', d.perros,
             'monto', d.monto
           ) order by d.inicio_local, d.id) as paseos
      from detalle d
     group by d.paseador_id
  ),
  choques as (
    select a.paseador_id,
           jsonb_agg(jsonb_build_object(
             'fecha',   a.fecha,
             'a_hora',  to_char(a.hora_programada, 'HH24:MI'),
             'a_fin',   to_char(a.fin_local, 'HH24:MI'),
             'a_grupo', a.grupo,
             'b_hora',  to_char(b.hora_programada, 'HH24:MI'),
             'b_grupo', b.grupo
           ) order by a.inicio_local, a.id, b.id) as lista
      from detalle a
      join detalle b
        on b.paseador_id = a.paseador_id
       and b.fecha = a.fecha
       and (b.inicio_local, b.id) > (a.inicio_local, a.id)
       and b.inicio_local < a.fin_local
     group by a.paseador_id
  ),
  sin_tarifa as (
    select x.paseador_id,
           jsonb_agg(x.nombre order by x.nombre) as lista
      from (
        select d.paseador_id, cl.id, cl.nombre
          from detalle d
          join paseo_perro pp on pp.paseo_id = d.id
                             and pp.estado = 'programado' and pp.se_cobra
          join perro pe   on pe.id = pp.perro_id
          join cliente cl on cl.id = pe.cliente_id
         where cl.tarifa_paseo is null
         group by d.paseador_id, cl.id, cl.nombre
        having sum(pp.precio_cobrado) > 0
      ) x
     group by x.paseador_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'paseador_id', c.paseador_id,
           'tipo',        'semanal',
           'email',       pa.email,
           'nombre',      pa.nombre,
           'desde',       v_desde,
           'hasta',       v_hasta,
           'n_paseos',    t.n,
           'monto',       t.monto,
           'paseos',      t.paseos,
           'choques',     coalesce(ch.lista, '[]'::jsonb),
           'sin_tarifa',  coalesce(st.lista, '[]'::jsonb)
         )), '[]'::jsonb)
    into v_correos
    from configuracion c
    join paseador pa on pa.id = c.paseador_id and pa.activo
    join totales t   on t.paseador_id = c.paseador_id
    left join choques ch    on ch.paseador_id = c.paseador_id
    left join sin_tarifa st on st.paseador_id = c.paseador_id
   where c.resumen_semanal_enviado_el is distinct from v_hoy;

  return v_correos;
end;
$$;

-- ---------------------------------------------------------
-- 2. La puerta: valida el secreto y devuelve la lista
--
-- Una puerta por canal, igual que `fn_avisos_pendientes`. El cierre de mes
-- se suma acá cuando se construya.
-- ---------------------------------------------------------
create or replace function fn_correos_pendientes(p_secreto text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not fn_secreto_push_valido(p_secreto) then
    return null;
  end if;

  return fn_correos_semanales_pendientes();
end;
$$;

-- ---------------------------------------------------------
-- 3. Registrar lo que pasó con el envío
--
-- Se marca la semana solo si el proveedor aceptó el correo; si no, se
-- reintenta en la próxima corrida mientras la ventana siga abierta.
-- ---------------------------------------------------------
create or replace function fn_registrar_correos(p_secreto text, p_resultados jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not fn_secreto_push_valido(p_secreto) then
    raise exception 'no autorizado';
  end if;

  update configuracion c
     set resumen_semanal_enviado_el = fn_hoy_local()
    from jsonb_to_recordset(coalesce(p_resultados->'correos', '[]'::jsonb))
           as r(paseador_id uuid, tipo text, entregado boolean)
   where c.paseador_id = r.paseador_id and r.entregado and r.tipo = 'semanal';
end;
$$;

-- ---------------------------------------------------------
-- 4. Permisos
--
-- La función por tipo no valida a nadie: si `anon` pudiera ejecutarla,
-- cualquiera con la llave pública leería nombres y correos de todos los
-- paseadores. Entra solo la puerta.
-- ---------------------------------------------------------
revoke execute on function fn_correos_semanales_pendientes() from public, anon, authenticated;
grant  execute on function fn_correos_pendientes(text)       to anon, authenticated;
grant  execute on function fn_registrar_correos(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------
-- 5. El agendamiento
--
-- Cada 15 minutos: el domingo hay una ventana de 3 horas y el correo no
-- necesita puntualidad al minuto. Si no cargaste `correo_url` en
-- `secreto_servidor`, el job falla en silencio (se ve en
-- cron.job_run_details) y no se manda nada:
--
--   insert into secreto_servidor (nombre, valor)
--   values ('correo_url', 'https://TU-APP.vercel.app/api/correo/enviar')
--   on conflict (nombre) do update set valor = excluded.valor;
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('enviar-correos');
exception when others then null;
end $$;

select cron.schedule(
  'enviar-correos',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select valor from secreto_servidor where nombre = 'correo_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select valor from secreto_servidor where nombre = 'push')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
