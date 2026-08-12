-- =========================================================
-- Feed de calendario (.ics) — spec §7
--
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo.
-- Es aditivo: no reescribe ni borra nada de lo que ya existe.
-- =========================================================

-- ---------------------------------------------------------
-- 1. Token y preferencia de privacidad
--
-- El token va en `configuracion` y no en `paseador` porque es una
-- preferencia, no identidad. Nunca se usa el id del paseador: la URL ES la
-- contraseña, así que tiene que ser un valor que se pueda regenerar sin
-- tocar las llaves foráneas de media base.
--
-- 64 caracteres hexadecimales salen de concatenar dos uuid. Es de sobra, y
-- evita depender de pgcrypto y de en qué esquema quedó instalado.
--
-- El default es volátil a propósito: obliga a Postgres a evaluarlo fila por
-- fila, así cada paseador que ya exista recibe un token distinto en vez de
-- compartir uno solo.
-- ---------------------------------------------------------
alter table configuracion
  add column token_calendario text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  add column calendario_incluye_notas boolean not null default false;

comment on column configuracion.calendario_incluye_notas is
  'Apagado por defecto (spec §7): las notas de acceso son códigos de portón y '
  'dónde está la llave de casas ajenas. Encenderlo las saca al calendario del '
  'teléfono y a su respaldo en la nube.';

-- ---------------------------------------------------------
-- 2. La agenda por token
--
-- SECURITY DEFINER para que la pueda llamar la llave `anon`: el feed lo pide
-- una app de calendario que no tiene sesión ni puede tenerla. La alternativa
-- —darle la llave `service_role` al servidor que arma el .ics— pondría una
-- llave que se salta RLS fuera de Supabase, y no hace falta.
--
-- Quien autoriza es el token, y se valida acá adentro. Si no corresponde a
-- nadie devuelve null y el servidor responde 404, sin distinguir entre
-- "token inválido" y "sin paseos".
--
-- Devuelve la misma forma que `SELECT_PASEO` usa en la app para que el
-- cálculo de la duración prevista sea exactamente el mismo código y no dos
-- implementaciones que se desincronizan.
-- ---------------------------------------------------------
create or replace function fn_agenda_por_token(
  p_token text,
  p_desde date,
  p_hasta date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_paseador uuid;
  v_config   jsonb;
  v_paseos   jsonb;
begin
  select paseador_id,
         jsonb_build_object(
           'duracion_default_min', duracion_default_min,
           'minutos_aviso_previo', minutos_aviso_previo,
           'calendario_incluye_notas', calendario_incluye_notas
         )
    into v_paseador, v_config
    from configuracion
   where token_calendario = p_token;

  if v_paseador is null then
    return null;
  end if;

  select coalesce(jsonb_agg(sub.e order by sub.fecha, sub.hora_programada), '[]'::jsonb)
    into v_paseos
    from (
      select p.fecha,
             p.hora_programada,
             jsonb_build_object(
               'id', p.id,
               'fecha', p.fecha,
               'hora_programada', p.hora_programada,
               'duracion_min', p.duracion_min,
               'estado', p.estado,
               'grupo', case when g.id is null then null
                             else jsonb_build_object('nombre', g.nombre) end,
               'paseo_recurrente', case when r.id is null then null
                                        else jsonb_build_object('duracion_min', r.duracion_min) end,
               'paseo_perro', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'estado', pp.estado,
                          'perro', jsonb_build_object(
                            'nombre', pe.nombre,
                            'duracion_min', pe.duracion_min,
                            'cliente', jsonb_build_object(
                              'nombre', cl.nombre,
                              'direccion', cl.direccion,
                              'notas_acceso', cl.notas_acceso
                            )
                          )
                        ))
                   from paseo_perro pp
                   join perro pe   on pe.id = pp.perro_id
                   join cliente cl on cl.id = pe.cliente_id
                  where pp.paseo_id = p.id
               ), '[]'::jsonb)
             ) as e
        from paseo p
        left join grupo g             on g.id = p.grupo_id
        left join paseo_recurrente r  on r.id = p.recurrente_id
       where p.paseador_id = v_paseador
         and p.fecha between p_desde and p_hasta
         -- Un paseo cancelado desaparece del calendario al refrescar. Que el
         -- teléfono decida cuándo refrescar es la limitación conocida del
         -- feed (spec §7), no algo que se pueda arreglar desde acá.
         and p.estado <> 'cancelado'
    ) sub;

  return jsonb_build_object('config', v_config, 'paseos', v_paseos);
end;
$$;

-- ---------------------------------------------------------
-- 3. Regenerar el token
--
-- Va como función y no como update directo para que la app no pueda escribir
-- un token elegido a mano: lo genera la base. Esta sí exige sesión — la
-- llama el paseador desde Ajustes, y RLS ya lo limita a su propia fila.
-- ---------------------------------------------------------
create or replace function fn_regenerar_token_calendario()
returns text
language sql
volatile
security invoker
set search_path = public
as $$
  update configuracion
     set token_calendario = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
   where paseador_id = auth.uid()
  returning token_calendario;
$$;
