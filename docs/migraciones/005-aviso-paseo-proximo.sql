-- =========================================================
-- Aviso de "paseo próximo" — spec §6
--
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo, después de la
-- 004. Se puede correr dos veces sin romperse. No toca los jobs de cron: el
-- mismo `enviar-avisos` de la 004 recoge el aviso nuevo.
--
-- Reglas de la especificación:
--   · Push `minutos_aviso_previo` antes del paseo (30 por defecto), con la
--     dirección en el cuerpo.
--   · Si el paseo ya se inició, el recordatorio se cancela solo.
--   · Dos paseos a menos de 45 minutos se agrupan en un solo aviso.
-- =========================================================

alter table paseo
  add column if not exists aviso_proximo_en timestamptz;

-- ---------------------------------------------------------
-- 1. Los avisos de "sin cerrar", movidos a su propia función
--
-- Es el mismo cuerpo que tenía `fn_avisos_pendientes` en la 004, sin la
-- validación del secreto. Se separa para que `fn_avisos_pendientes` sea solo
-- la puerta —valida el secreto y junta las listas— y cada tipo de aviso
-- viva en su propia función.
--
-- Al no validar a nadie, estas funciones son SECURITY DEFINER sin quién las
-- proteja adentro: por eso se les quita el permiso a todos (sección 4). Solo
-- las llama `fn_avisos_pendientes`, que corre como el dueño.
-- ---------------------------------------------------------
create or replace function fn_avisos_olvido_pendientes()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_primero_min  constant integer := 15;
  v_segundo_min  constant integer := 30;
  v_espera_cierre_min constant integer := 15;  -- igual que en fn_cerrar_olvidados_paseador
  v_hoy   date := fn_hoy_local();
  v_avisos jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'paseo_id', x.id,
           'tipo',     x.tipo,
           'tag',      'paseo-' || x.id || '-' || x.tipo,
           'url',      '/paseo/' || x.id,
           'titulo',   case x.tipo
                         when 'olvido_1' then 'Tu paseo sigue corriendo'
                         else 'Voy a cerrar tu paseo'
                       end,
           'cuerpo',   case x.tipo
                         when 'olvido_1' then
                           format('%s pasó los %s min previstos. Termínalo, o sigue si aún estás caminando.',
                                  x.nombre, x.prevista_min)
                         else
                           format('Si no lo terminas, lo cierro en %s min con los %s min previstos.',
                                  v_espera_cierre_min, x.prevista_min)
                       end,
           'suscripciones', x.suscripciones
         )), '[]'::jsonb)
    into v_avisos
    from (
      select e.id, e.prevista_min, e.tipo,
             coalesce(g.nombre, 'El paseo') as nombre,
             (select jsonb_agg(jsonb_build_object(
                       'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                from suscripcion_push s
               where s.paseador_id = e.paseador_id and s.activa) as suscripciones
        from (
          select p.id, p.paseador_id, p.grupo_id,
                 fn_duracion_prevista_paseo(p.id) as prevista_min,
                 case
                   when p.aviso_olvido_1_en is null
                        and ex.excedido_seg >= v_primero_min * 60
                     then 'olvido_1'
                   when p.aviso_olvido_1_en is not null
                        and p.aviso_olvido_2_en is null
                        and ex.excedido_seg >= v_segundo_min * 60
                        and now() - p.aviso_olvido_1_en >= interval '10 minutes'
                     then 'olvido_2'
                 end as tipo
            from paseo p
            cross join lateral (
              select extract(epoch from (now() - p.inicio_real))
                     - coalesce(p.pausado_seg, 0)
                     - fn_duracion_prevista_paseo(p.id) * 60 as excedido_seg
            ) ex
           where p.estado = 'en_curso'
             and p.inicio_real is not null
             and p.fecha >= v_hoy
        ) e
        left join grupo g on g.id = e.grupo_id
       where e.tipo is not null
    ) x
   where x.suscripciones is not null;

  return v_avisos;
end;
$$;

-- ---------------------------------------------------------
-- 2. Los avisos de "paseo próximo"
--
-- La hora de un paseo son dos columnas, `fecha` y `hora_programada`, y las
-- dos son hora LOCAL de Chile. El servidor está en UTC, así que se convierten
-- con `at time zone 'America/Santiago'` antes de compararlas con `now()`:
-- sin eso el aviso saldría cuatro o tres horas corrido, y el corrimiento
-- cambia con el horario de verano.
--
-- Solo se avisa de paseos `programado`: uno que ya se inició, se canceló o se
-- cerró no entra, que es la regla de "el recordatorio se cancela solo". Un
-- paseo cuyos perros se cancelaron uno por uno tampoco: no hay a quién ir a
-- buscar.
--
-- Agrupación. Dos paseos se juntan en un solo aviso si entre el FIN previsto
-- del anterior y el INICIO del siguiente hay menos de 45 minutos. Se mide
-- desde el fin y no entre inicios porque lo que la regla evita es que el
-- aviso del segundo paseo suene en medio del primero: con un paseo de 60 min
-- y otro 75 min después, el segundo estaría a solo 15 min de terminar el
-- primero, y medir inicios no lo agruparía. Una cadena de paseos cada uno a
-- menos de 45 min del anterior forma un solo bloque. El aviso sale
-- `minutos_aviso_previo` antes del primero del bloque y los nombra a todos.
--
-- El cuerpo lleva las direcciones y NO las notas de acceso: un push queda en
-- la pantalla de bloqueo, y las notas son códigos de portón y dónde está la
-- llave de casas ajenas (spec §7, nota de privacidad).
--
-- Un aviso solo se manda antes de la hora de inicio: "sale en 30 minutos" a
-- las 10:05 para un paseo de las 10:00 no le sirve a nadie. Si el cron estuvo
-- caído toda la ventana, ese aviso simplemente no sale.
-- ---------------------------------------------------------
create or replace function fn_avisos_proximo_pendientes()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_union_min constant integer := 45;
  v_zona      constant text := 'America/Santiago';
  v_hoy       date := fn_hoy_local();
  v_avisos    jsonb;
begin
  with base as (
    select p.id, p.paseador_id, p.grupo_id,
           (p.fecha + p.hora_programada) at time zone v_zona as inicio,
           (p.fecha + p.hora_programada) at time zone v_zona
             + fn_duracion_prevista_paseo(p.id) * interval '1 minute' as fin,
           c.minutos_aviso_previo as previo_min
      from paseo p
      join configuracion c on c.paseador_id = p.paseador_id
     where p.estado = 'programado'
       and p.aviso_proximo_en is null
       and p.fecha between v_hoy and v_hoy + 1
       -- Un paseo cuya hora ya pasó y sigue `programado` (el paseador va
       -- atrasado) se saca ANTES de agrupar, no después. Si entrara, se
       -- juntaría con el paseo siguiente y anclaría el bloque a una hora ya
       -- pasada: el aviso del siguiente, que sí es útil, se perdería entero.
       and (p.fecha + p.hora_programada) at time zone v_zona > now()
       and exists (select 1 from paseo_perro pp
                    where pp.paseo_id = p.id and pp.estado = 'programado')
       and exists (select 1 from suscripcion_push s
                    where s.paseador_id = p.paseador_id and s.activa)
  ),
  con_previo as (
    select b.*,
           max(b.fin) over (
             partition by b.paseador_id order by b.inicio, b.id
             rows between unbounded preceding and 1 preceding
           ) as fin_previo
      from base b
  ),
  con_bloque as (
    select cp.*,
           sum(case when cp.fin_previo is null
                         or cp.inicio - cp.fin_previo >= v_union_min * interval '1 minute'
                    then 1 else 0 end)
             over (partition by cp.paseador_id order by cp.inicio, cp.id) as bloque
      from con_previo cp
  ),
  lineas as (
    select cb.*,
           coalesce(g.nombre, 'Paseo') as nombre_grupo,
           -- Hasta tres direcciones distintas; el resto se resume, que una
           -- notificación larga se corta sola en la pantalla de bloqueo.
           nullif((
             select coalesce(string_agg(d.direccion, ' · ' order by d.direccion)
                               filter (where d.rn <= 3), '')
                    || case when count(*) > 3
                            then format(' y %s más', count(*) - 3) else '' end
               from (
                 select x.direccion,
                        row_number() over (order by x.direccion) as rn
                   from (
                     select distinct cl.direccion
                       from paseo_perro pp
                       join perro pe   on pe.id = pp.perro_id
                       join cliente cl on cl.id = pe.cliente_id
                      where pp.paseo_id = cb.id
                        and pp.estado = 'programado'
                        and cl.direccion is not null
                        and cl.direccion <> ''
                   ) x
               ) d
           ), '') as direcciones
      from con_bloque cb
      left join grupo g on g.id = cb.grupo_id
  ),
  bloques as (
    select l.paseador_id, l.bloque,
           min(l.inicio)      as inicio_bloque,
           min(l.previo_min)  as previo_min,
           count(*)           as n,
           array_agg(l.id order by l.inicio, l.id) as ids,
           string_agg(l.nombre_grupo || ': ' || coalesce(l.direcciones, 'sin dirección registrada'),
                      E'\n' order by l.inicio, l.id) as cuerpo_simple,
           string_agg(to_char(l.inicio at time zone v_zona, 'HH24:MI') || ' '
                      || l.nombre_grupo || ': ' || coalesce(l.direcciones, 'sin dirección registrada'),
                      E'\n' order by l.inicio, l.id) as cuerpo_con_hora
      from lineas l
     group by l.paseador_id, l.bloque
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'paseo_id',  b.ids[1],
           'paseo_ids', to_jsonb(b.ids),
           'tipo',      'proximo',
           'tag',       'proximo-' || b.ids[1],
           'url',       '/paseo/' || b.ids[1],
           'titulo',    case when b.n = 1
                             then 'Paseo a las ' || to_char(b.inicio_bloque at time zone v_zona, 'HH24:MI')
                             else format('%s paseos desde las %s', b.n,
                                         to_char(b.inicio_bloque at time zone v_zona, 'HH24:MI'))
                        end,
           'cuerpo',    case when b.n = 1 then b.cuerpo_simple else b.cuerpo_con_hora end,
           'suscripciones', (
             select jsonb_agg(jsonb_build_object(
                      'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
               from suscripcion_push s
              where s.paseador_id = b.paseador_id and s.activa)
         )), '[]'::jsonb)
    into v_avisos
    from bloques b
   -- Solo la cota inferior: que el bloque no haya empezado ya lo garantiza el
   -- filtro de `base`, que descarta los paseos con la hora pasada.
   where now() >= b.inicio_bloque - b.previo_min * interval '1 minute';

  return v_avisos;
end;
$$;

-- ---------------------------------------------------------
-- 3. La puerta: valida el secreto y junta las listas
-- ---------------------------------------------------------
create or replace function fn_avisos_pendientes(p_secreto text)
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

  return fn_avisos_olvido_pendientes() || fn_avisos_proximo_pendientes();
end;
$$;

-- ---------------------------------------------------------
-- 4. Permisos
--
-- Las dos funciones por tipo no validan a nadie: si `anon` pudiera
-- ejecutarlas, cualquiera con la llave pública leería direcciones y
-- suscripciones de todos los paseadores. Se cierran; entra solo la puerta.
-- ---------------------------------------------------------
revoke execute on function fn_avisos_olvido_pendientes()  from public, anon, authenticated;
revoke execute on function fn_avisos_proximo_pendientes() from public, anon, authenticated;
grant  execute on function fn_avisos_pendientes(text)     to anon, authenticated;

-- ---------------------------------------------------------
-- 5. Registrar lo que pasó con el envío
--
-- Igual que en la 004, más el tipo `proximo`: un aviso de bloque lleva
-- `paseo_ids` (todos los paseos que cubre) y los marca juntos. Se marca solo
-- si algún dispositivo lo recibió; si no, se reintenta en la próxima corrida
-- mientras la ventana siga abierta.
-- ---------------------------------------------------------
create or replace function fn_registrar_avisos(p_secreto text, p_resultados jsonb)
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

  update paseo p
     set aviso_olvido_1_en = now()
    from jsonb_to_recordset(coalesce(p_resultados->'avisos', '[]'::jsonb))
           as r(paseo_id uuid, tipo text, entregado boolean)
   where p.id = r.paseo_id and r.entregado and r.tipo = 'olvido_1'
     and p.aviso_olvido_1_en is null;

  update paseo p
     set aviso_olvido_2_en = now()
    from jsonb_to_recordset(coalesce(p_resultados->'avisos', '[]'::jsonb))
           as r(paseo_id uuid, tipo text, entregado boolean)
   where p.id = r.paseo_id and r.entregado and r.tipo = 'olvido_2'
     and p.aviso_olvido_2_en is null;

  update paseo
     set aviso_proximo_en = now()
   where aviso_proximo_en is null
     and id in (
       select ids.valor::uuid
         from jsonb_to_recordset(coalesce(p_resultados->'avisos', '[]'::jsonb))
                as r(tipo text, entregado boolean, paseo_ids jsonb)
        cross join lateral jsonb_array_elements_text(r.paseo_ids) as ids(valor)
        where r.tipo = 'proximo' and r.entregado and r.paseo_ids is not null
     );

  update suscripcion_push
     set activa = false
   where endpoint in (
     select jsonb_array_elements_text(coalesce(p_resultados->'caducadas', '[]'::jsonb))
   );
end;
$$;
