-- =========================================================
-- Resumen del día — spec §6
--
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo, después de la
-- 005. Se puede correr dos veces sin romperse. No toca los jobs de cron: el
-- mismo `enviar-avisos` recoge el aviso nuevo.
--
-- Reglas de la especificación:
--   · Push a `hora_resumen_diario` (7:30 por defecto), con la hora estimada
--     de término.
--   · Si no hay paseos ese día, no se envía nada.
--
-- No lleva direcciones ni notas de acceso: es un panorama del día, y los
-- detalles de cada casa ya los trae el aviso de paseo próximo.
-- =========================================================

-- El resumen no es de un paseo sino del paseador, así que su marca de
-- "ya enviado" vive en `configuracion`, como fecha local. Con una fecha y no
-- un timestamp, "¿ya se mandó hoy?" es una comparación directa y no depende
-- de la zona horaria del servidor.
alter table configuracion
  add column if not exists resumen_enviado_el date;

-- ---------------------------------------------------------
-- 1. Los avisos de "resumen del día"
--
-- `hora_resumen_diario` es hora LOCAL de Chile, igual que `hora_programada`:
-- se convierte con `at time zone` antes de compararla con `now()`.
--
-- Ventana. El resumen sale desde la hora configurada y deja de valer 2 horas
-- después: "estos son tus paseos de hoy" a las 11 de la mañana, con el día
-- ya empezado, no le sirve a nadie. Si el cron estuvo caído toda la ventana,
-- ese día no hay resumen.
--
-- Cuenta solo paseos `programado` que aún tienen algún perro `programado`
-- (un paseo con todos sus perros cancelados no tiene a quién ir a buscar).
-- La hora de término estimada es el mayor inicio + duración prevista.
-- ---------------------------------------------------------
create or replace function fn_avisos_resumen_pendientes()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ventana_min constant integer := 120;
  v_zona        constant text := 'America/Santiago';
  v_hoy         date := fn_hoy_local();
  v_avisos      jsonb;
begin
  with dia as (
    select p.paseador_id,
           count(*) as n,
           min((p.fecha + p.hora_programada) at time zone v_zona) as primer_inicio,
           max((p.fecha + p.hora_programada) at time zone v_zona
                 + fn_duracion_prevista_paseo(p.id) * interval '1 minute') as ultimo_fin
      from paseo p
     where p.estado = 'programado'
       and p.fecha = v_hoy
       and exists (select 1 from paseo_perro pp
                    where pp.paseo_id = p.id and pp.estado = 'programado')
     group by p.paseador_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'paseador_id', d.paseador_id,
           'tipo',        'resumen',
           'tag',         'resumen-' || v_hoy,
           'url',         '/',
           'titulo',      case when d.n = 1 then 'Hoy tienes 1 paseo'
                               else format('Hoy tienes %s paseos', d.n) end,
           'cuerpo',      case when d.n = 1
                               then format('A las %s, termina hacia las %s.',
                                           to_char(d.primer_inicio at time zone v_zona, 'HH24:MI'),
                                           to_char(d.ultimo_fin    at time zone v_zona, 'HH24:MI'))
                               else format('Desde las %s, terminas hacia las %s.',
                                           to_char(d.primer_inicio at time zone v_zona, 'HH24:MI'),
                                           to_char(d.ultimo_fin    at time zone v_zona, 'HH24:MI'))
                          end,
           'suscripciones', (
             select jsonb_agg(jsonb_build_object(
                      'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
               from suscripcion_push s
              where s.paseador_id = d.paseador_id and s.activa)
         )), '[]'::jsonb)
    into v_avisos
    from dia d
    join configuracion c on c.paseador_id = d.paseador_id
   where c.resumen_enviado_el is distinct from v_hoy
     and now() >= (v_hoy + c.hora_resumen_diario) at time zone v_zona
     and now() <  (v_hoy + c.hora_resumen_diario) at time zone v_zona
                   + v_ventana_min * interval '1 minute'
     and exists (select 1 from suscripcion_push s
                  where s.paseador_id = d.paseador_id and s.activa);

  return v_avisos;
end;
$$;

-- ---------------------------------------------------------
-- 2. La puerta: suma el resumen a las listas
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

  return fn_avisos_olvido_pendientes()
      || fn_avisos_proximo_pendientes()
      || fn_avisos_resumen_pendientes();
end;
$$;

-- ---------------------------------------------------------
-- 3. Permisos: la función por tipo no valida a nadie, solo entra la puerta
-- ---------------------------------------------------------
revoke execute on function fn_avisos_resumen_pendientes() from public, anon, authenticated;
grant  execute on function fn_avisos_pendientes(text)     to anon, authenticated;

-- ---------------------------------------------------------
-- 4. Registrar lo que pasó con el envío
--
-- Igual que en la 005, más el tipo `resumen`: se marca el día como enviado
-- solo si algún dispositivo lo recibió; si no, se reintenta en la próxima
-- corrida mientras la ventana siga abierta.
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

  update configuracion c
     set resumen_enviado_el = fn_hoy_local()
    from jsonb_to_recordset(coalesce(p_resultados->'avisos', '[]'::jsonb))
           as r(paseador_id uuid, tipo text, entregado boolean)
   where c.paseador_id = r.paseador_id and r.entregado and r.tipo = 'resumen';

  update suscripcion_push
     set activa = false
   where endpoint in (
     select jsonb_array_elements_text(coalesce(p_resultados->'caducadas', '[]'::jsonb))
   );
end;
$$;
