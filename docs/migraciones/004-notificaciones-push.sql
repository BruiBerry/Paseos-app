-- =========================================================
-- Notificaciones push — spec §6, primer corte: "cronómetro sin cerrar"
--
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo. Se puede correr
-- dos veces sin romperse.
--
-- Antes de correrla: Database → Extensions → habilita `pg_net` (el cron la
-- usa para llamar al endpoint de Vercel).
--
-- Después de correrla: carga los secretos (ver sección 1). Hasta entonces el
-- job `enviar-avisos` falla en silencio. El secreto lo generas tú, con
--   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
-- y NO va en el repositorio ni en Vercel: solo en la base. El endpoint lo
-- recibe en la cabecera del cron y se lo pasa a la base, que es quien lo
-- valida.
-- =========================================================

create extension if not exists pg_net;

-- ---------------------------------------------------------
-- 1. Secretos del servidor
--
-- RLS encendido y sin ninguna política: ni `anon` ni `authenticated` pueden
-- leer ni escribir. Solo entran las funciones SECURITY DEFINER y pg_cron,
-- que corren como el dueño. Los valores se cargan a mano en el editor SQL:
--
--   insert into secreto_servidor (nombre, valor) values
--     ('push',     '<el secreto generado>'),
--     ('push_url', 'https://TU-APP.vercel.app/api/push/enviar')
--   on conflict (nombre) do update set valor = excluded.valor;
-- ---------------------------------------------------------
create table if not exists secreto_servidor (
  nombre text primary key,
  valor  text not null
);
alter table secreto_servidor enable row level security;
revoke all on secreto_servidor from anon, authenticated;

create or replace function fn_secreto_push_valido(p_secreto text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from secreto_servidor
     where nombre = 'push' and valor = p_secreto and p_secreto <> ''
  );
$$;
revoke execute on function fn_secreto_push_valido(text) from public, anon, authenticated;

-- ---------------------------------------------------------
-- 2. Suscripciones push
--
-- Una fila por dispositivo (endpoint). Nada se borra: una suscripción que el
-- servicio de push declara muerta (404/410) queda `activa = false`, y si el
-- paseador vuelve a activar los avisos en ese dispositivo se reactiva.
-- ---------------------------------------------------------
create table if not exists suscripcion_push (
  id          uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  activa      boolean not null default true,
  creada_en   timestamptz not null default now()
);
create index if not exists idx_suscripcion_push_paseador on suscripcion_push(paseador_id);

alter table suscripcion_push enable row level security;
drop policy if exists "propio" on suscripcion_push;
create policy "propio" on suscripcion_push
  for all using (paseador_id = auth.uid()) with check (paseador_id = auth.uid());

-- ---------------------------------------------------------
-- 3. Qué avisos ya salieron
--
-- Solo se marcan cuando al menos un dispositivo LO RECIBIÓ. Ese "entregado"
-- es lo que autoriza al cierre a bajar de 180 a 15 minutos: el cierre a los
-- 15 se apoya en "el paseador fue avisado y lo ignoró", y sin push activo no
-- hay nada que ignorar.
-- ---------------------------------------------------------
alter table paseo
  add column if not exists aviso_olvido_1_en timestamptz,
  add column if not exists aviso_olvido_2_en timestamptz;

-- ---------------------------------------------------------
-- 4. Los avisos por mandar
--
-- Escalera (spec §4, "Cierre automático de paseos olvidados"):
--   prevista + 15 min → primer aviso
--   prevista + 30 min → insiste una vez (y al menos 10 min después del primero,
--                       por si el primero salió tarde)
--   segundo aviso + 15 min → cierra (ver fn_cerrar_olvidados_paseador)
--
-- Los paseos de días anteriores no reciben aviso: el cierre los cierra de
-- inmediato, y avisar de algo que ya no tiene salida no es accionable.
--
-- Solo se consideran paseadores con alguna suscripción activa. Los demás no
-- tienen a quién avisar, así que su paseo no se marca y el cierre los cubre
-- con el margen largo.
--
-- Devuelve null si el secreto no corresponde; el endpoint responde 401.
-- No marca nada: eso lo hace fn_registrar_avisos cuando el envío terminó, así
-- que un aviso que falló se reintenta en la próxima corrida.
-- ---------------------------------------------------------
create or replace function fn_avisos_pendientes(p_secreto text)
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
  if not fn_secreto_push_valido(p_secreto) then
    return null;
  end if;

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
-- 5. Registrar lo que pasó con el envío
--
-- p_resultados = {
--   "avisos":   [{ "paseo_id": "...", "tipo": "olvido_1", "entregado": true }],
--   "caducadas": ["<endpoint>", ...]
-- }
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

  update suscripcion_push
     set activa = false
   where endpoint in (
     select jsonb_array_elements_text(coalesce(p_resultados->'caducadas', '[]'::jsonb))
   );
end;
$$;

-- Para el aviso de prueba (`?prueba=1`): todas las suscripciones activas.
create or replace function fn_suscripciones_push(p_secreto text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when fn_secreto_push_valido(p_secreto) then
    coalesce((select jsonb_agg(jsonb_build_object(
                       'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
                from suscripcion_push where activa), '[]'::jsonb)
  end;
$$;

-- Son SECURITY DEFINER y las llama la llave `anon` desde el servidor: quien
-- autoriza es el secreto, validado adentro. El default de Postgres las deja
-- ejecutables por todos, y eso es lo que queremos aquí (a diferencia de las
-- `_todos` de la 002, que no validan a nadie y por eso se revocan).
grant execute on function fn_avisos_pendientes(text)       to anon, authenticated;
grant execute on function fn_registrar_avisos(text, jsonb) to anon, authenticated;
grant execute on function fn_suscripciones_push(text)      to anon, authenticated;

-- ---------------------------------------------------------
-- 6. El cierre, ahora apoyado en los avisos
--
-- Reemplaza la de la 002. Un paseo de HOY se cierra si:
--   · el segundo aviso salió y pasaron 15 min sin que el paseador lo
--     terminara (la escalera de la especificación), o
--   · se pasó del margen largo de 180 min. Es la red de seguridad de siempre:
--     sin push activo, o con el servicio de push caído, no hay "lo ignoró"
--     que detectar, y cerrar a los 15 minutos mataría por la espalda un paseo
--     que de verdad se alargó — marcando sus perros como completados, que es
--     dinero.
--
-- Limitación conocida: `pausado_seg` se escribe al reanudar, así que un paseo
-- que está pausado en este momento no descuenta la pausa en curso. Un paseador
-- que deja la pausa abierta más de 45 minutos pasada la duración prevista
-- recibe los avisos y se cierra igual; es lo que la especificación pide.
-- ---------------------------------------------------------
create or replace function fn_cerrar_olvidados_paseador(p_paseador_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_margen_sin_avisos_min constant integer := 180;
  v_espera_cierre_min     constant integer := 15;  -- igual que en fn_avisos_pendientes
  v_hoy        date := fn_hoy_local();
  v_p          record;
  v_prevista   integer;
  v_excedido   numeric;
  v_cerrados   integer := 0;
begin
  for v_p in
    select id, fecha, inicio_real, coalesce(pausado_seg, 0) as pausado_seg,
           aviso_olvido_2_en
      from paseo
     where paseador_id = p_paseador_id
       and estado = 'en_curso'
       and inicio_real is not null
  loop
    v_prevista := fn_duracion_prevista_paseo(v_p.id);
    v_excedido := extract(epoch from (now() - v_p.inicio_real))
                  - v_p.pausado_seg
                  - (v_prevista * 60);

    if v_excedido <= 0 then
      continue;
    end if;

    if v_p.fecha >= v_hoy
       and v_excedido <= v_margen_sin_avisos_min * 60
       and not (v_p.aviso_olvido_2_en is not null
                and now() - v_p.aviso_olvido_2_en >= make_interval(mins => v_espera_cierre_min))
    then
      continue;
    end if;

    -- El fin se calcula, no se pone `now()` (ver 002): el paseo se cierra con
    -- la duración prevista.
    update paseo
       set estado       = 'cerrado_automaticamente',
           fin_real     = inicio_real + make_interval(secs => v_p.pausado_seg + v_prevista * 60),
           duracion_seg = v_prevista * 60
     where id = v_p.id;

    update paseo_perro
       set estado = 'completado'
     where paseo_id = v_p.id
       and estado = 'programado';

    v_cerrados := v_cerrados + 1;
  end loop;

  return v_cerrados;
end;
$$;

-- ---------------------------------------------------------
-- 7. El agendamiento
--
-- El cierre pasa de cada hora a cada 5 minutos: la escalera se mide en
-- minutos, y con corridas horarias un paseo esperaría hasta 60 minutos
-- extra después de que su plazo venció. Recorre solo los `en_curso`.
--
-- Los avisos salen cada 5 minutos: un aviso de "pasaste la duración" llega
-- con hasta 5 minutos de retraso, que para este uso no importa.
--
-- Si no cargaste `push_url` y `push` en `secreto_servidor`, el job falla en
-- silencio (se ve en cron.job_run_details) y no se manda nada.
-- ---------------------------------------------------------
do $$
begin
  perform cron.unschedule('cerrar-olvidados');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('enviar-avisos');
exception when others then null;
end $$;

select cron.schedule(
  'cerrar-olvidados',
  '*/5 * * * *',
  $$select fn_cerrar_olvidados_todos()$$
);

select cron.schedule(
  'enviar-avisos',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select valor from secreto_servidor where nombre = 'push_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select valor from secreto_servidor where nombre = 'push')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
