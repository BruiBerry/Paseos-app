-- =========================================================
-- App de paseo de perros — esquema inicial
-- Para pegar en el editor SQL de Supabase
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- PASEADOR
-- Una fila por cuenta. El id coincide con el id de auth.users
-- que Supabase crea al invitar al usuario, así que el aislamiento
-- de datos se puede anclar directamente a auth.uid().
-- ---------------------------------------------------------
create table paseador (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  email text not null,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

-- ---------------------------------------------------------
-- CONFIGURACION — una fila por paseador
-- ---------------------------------------------------------
create table configuracion (
  paseador_id uuid primary key references paseador(id) on delete cascade,
  tarifa_default integer not null default 7000,
  recargo_perro_adicional integer not null default 3000,
  duracion_default_min integer not null default 60,
  radio_geocerca_m integer not null default 100,
  hora_resumen_diario time not null default '07:30',
  minutos_aviso_previo integer not null default 30,
  -- Feed .ics (spec §7). La URL es la contraseña, así que el token es un
  -- valor aleatorio y regenerable, nunca el id del paseador.
  token_calendario text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- Apagado por defecto: son códigos de portón y llaves de casas ajenas.
  calendario_incluye_notas boolean not null default false
);

-- ---------------------------------------------------------
-- CLIENTE
-- ---------------------------------------------------------
create table cliente (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  nombre text not null,
  telefono text,
  email text,
  direccion text,
  lat double precision,
  lng double precision,
  tarifa_paseo integer,              -- null = usa tarifa_default
  tarifa_perro_adicional integer,    -- null = usa recargo_perro_adicional
  notas_acceso text,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);
create index idx_cliente_paseador on cliente(paseador_id);

-- ---------------------------------------------------------
-- PERRO
-- ---------------------------------------------------------
create table perro (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  cliente_id uuid not null references cliente(id) on delete cascade,
  nombre text not null,
  duracion_min integer,              -- null = usa duracion_default_min
  color_hex text not null default '#7F77DD',
  notas text,
  activo boolean not null default true
);
create index idx_perro_paseador on perro(paseador_id);
create index idx_perro_cliente on perro(cliente_id);

-- ---------------------------------------------------------
-- GRUPO — conjunto de perros que se pasean juntos
-- ---------------------------------------------------------
create table grupo (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  nombre text not null,
  color_hex text not null default '#1D9E75',
  zona text
);
create index idx_grupo_paseador on grupo(paseador_id);

create table grupo_perro (
  grupo_id uuid not null references grupo(id) on delete cascade,
  perro_id uuid not null references perro(id) on delete cascade,
  primary key (grupo_id, perro_id)
);

-- ---------------------------------------------------------
-- PASEO_RECURRENTE — la regla, no las ocurrencias
-- ---------------------------------------------------------
create table paseo_recurrente (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  grupo_id uuid not null references grupo(id) on delete cascade,
  dias_semana integer[] not null,    -- 1=lunes ... 7=domingo
  hora_inicio time not null,
  duracion_min integer,              -- null = cascada normal
  vigente_desde date not null,
  vigente_hasta date,                -- null = indefinido
  activo boolean not null default true
);
create index idx_recurrente_paseador on paseo_recurrente(paseador_id);

-- ---------------------------------------------------------
-- PASEO — la ocurrencia concreta
-- Sin cliente_id ni precio: un paseo puede incluir perros
-- de varios dueños (grupo) o de uno solo (suelto).
-- ---------------------------------------------------------
create type estado_paseo as enum (
  'programado', 'en_curso', 'completado', 'cancelado', 'cerrado_automaticamente'
);

create table paseo (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  grupo_id uuid references grupo(id) on delete set null,
  recurrente_id uuid references paseo_recurrente(id) on delete set null,
  fecha date not null,
  hora_programada time not null,
  duracion_min integer,              -- paso 1 de la cascada; null = sigue al paso 2
  estado estado_paseo not null default 'programado',
  inicio_real timestamptz,
  fin_real timestamptz,
  duracion_seg integer,              -- duración final, ya sin las pausas
  pausado_seg integer not null default 0,
  inicio_automatico boolean not null default false,
  notas text
);
create index idx_paseo_paseador_fecha on paseo(paseador_id, fecha);

-- ---------------------------------------------------------
-- PASEO_PERRO — aquí vive el dinero, una fila por perro
-- paseador_id va denormalizado para que la política RLS
-- no tenga que hacer join contra paseo en cada consulta.
-- ---------------------------------------------------------
create type estado_paseo_perro as enum ('programado', 'completado', 'cancelado');

create table paseo_perro (
  paseo_id uuid not null references paseo(id) on delete cascade,
  perro_id uuid not null references perro(id) on delete cascade,
  paseador_id uuid not null references paseador(id) on delete cascade,
  precio_cobrado integer not null,   -- congelado al crear la fila
  se_cobra boolean not null default true,
  estado estado_paseo_perro not null default 'programado',
  motivo_cancelacion text,
  primary key (paseo_id, perro_id)
);
create index idx_paseoperro_paseador on paseo_perro(paseador_id);

-- ---------------------------------------------------------
-- COBRO — boleta mensual por cliente
-- ---------------------------------------------------------
create type estado_cobro as enum ('pendiente', 'cobrado');

create table cobro (
  id uuid primary key default gen_random_uuid(),
  paseador_id uuid not null references paseador(id) on delete cascade,
  cliente_id uuid not null references cliente(id) on delete cascade,
  periodo text not null,             -- '2026-07'
  monto integer not null,
  estado estado_cobro not null default 'pendiente',
  fecha_pago date,
  unique (paseador_id, cliente_id, periodo)
);
create index idx_cobro_paseador on cobro(paseador_id);

-- =========================================================
-- ROW LEVEL SECURITY
-- Cada paseador solo ve sus propias filas. Esto se aplica
-- en la base de datos, no en el código de la app.
-- =========================================================

alter table configuracion   enable row level security;
alter table cliente         enable row level security;
alter table perro           enable row level security;
alter table grupo           enable row level security;
alter table grupo_perro     enable row level security;
alter table paseo_recurrente enable row level security;
alter table paseo           enable row level security;
alter table paseo_perro     enable row level security;
alter table cobro           enable row level security;

create policy "propio" on configuracion    for all using (paseador_id = auth.uid());
create policy "propio" on cliente          for all using (paseador_id = auth.uid());
create policy "propio" on perro            for all using (paseador_id = auth.uid());
create policy "propio" on grupo            for all using (paseador_id = auth.uid());
create policy "propio" on paseo_recurrente for all using (paseador_id = auth.uid());
create policy "propio" on paseo            for all using (paseador_id = auth.uid());
create policy "propio" on paseo_perro      for all using (paseador_id = auth.uid());
create policy "propio" on cobro            for all using (paseador_id = auth.uid());

-- grupo_perro no tiene paseador_id propio: se filtra a través del grupo
create policy "propio" on grupo_perro
  for all using (
    exists (select 1 from grupo g where g.id = grupo_perro.grupo_id and g.paseador_id = auth.uid())
  );

-- =========================================================
-- FUNCIONES DE CASCADA
-- =========================================================

-- Duración de un perro: propia, o la default del paseador
create or replace function fn_duracion_perro(p_perro_id uuid)
returns integer language sql stable as $$
  select coalesce(
    p.duracion_min,
    (select c.duracion_default_min from configuracion c where c.paseador_id = p.paseador_id)
  )
  from perro p where p.id = p_perro_id;
$$;

-- Duración de un paseo dado el conjunto de perros que participan:
-- la más larga entre ellos, salvo que el paseo o la regla la fijen a mano
create or replace function fn_duracion_paseo(p_perro_ids uuid[])
returns integer language sql stable as $$
  select max(fn_duracion_perro(id)) from unnest(p_perro_ids) as id;
$$;

-- Precio de los perros de UN cliente dentro de un mismo paseo:
-- el primero paga tarifa completa, los siguientes pagan el recargo.
-- Devuelve (perro_id, precio) para que el llamador arme paseo_perro.
create or replace function fn_precios_cliente_en_paseo(
  p_cliente_id uuid, p_perro_ids uuid[]
) returns table(perro_id uuid, precio integer) language plpgsql stable as $$
declare
  v_tarifa integer;
  v_recargo integer;
  v_paseador uuid;
begin
  select paseador_id, tarifa_paseo, tarifa_perro_adicional
    into v_paseador, v_tarifa, v_recargo
    from cliente where id = p_cliente_id;

  if v_tarifa is null then
    select tarifa_default into v_tarifa from configuracion where paseador_id = v_paseador;
  end if;
  if v_recargo is null then
    select recargo_perro_adicional into v_recargo from configuracion where paseador_id = v_paseador;
  end if;

  return query
  select pr.id,
    case when row_number() over (order by pr.id) = 1 then v_tarifa else v_recargo end
  from perro pr
  where pr.id = any(p_perro_ids) and pr.cliente_id = p_cliente_id;
end;
$$;

-- =========================================================
-- Notas de implementación:
--
-- 1. Crear un paseo es un flujo de dos pasos desde la app:
--    a) insertar la fila en `paseo`
--    b) por cada cliente presente en el paseo, llamar a
--       fn_precios_cliente_en_paseo y usar el resultado para
--       insertar las filas de paseo_perro con precio_cobrado
--       ya calculado y congelado.
--
-- 2. La materialización de paseo_recurrente (generar 8 semanas
--    de ocurrencias hacia adelante) conviene correrla como una
--    Edge Function programada de Supabase, no como función SQL,
--    porque necesita decidir qué fechas ya existen antes de
--    volver a generar.
-- =========================================================

-- ---------------------------------------------------------
-- RLS faltante: la tabla paseador misma
-- ---------------------------------------------------------
alter table paseador enable row level security;

create policy "propio" on paseador
  for all using (id = auth.uid());

-- ---------------------------------------------------------
-- Trigger: al crear un usuario en auth.users, crear su fila
-- en paseador y su fila de configuracion con valores por defecto.
-- Así invitar a alguien desde el panel de Supabase deja la
-- cuenta lista para usar sin pasos manuales adicionales.
-- ---------------------------------------------------------
create or replace function fn_nuevo_paseador()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.paseador (id, nombre, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', new.email), new.email);

  insert into public.configuracion (paseador_id) values (new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function fn_nuevo_paseador();

-- =========================================================
-- FEED DE CALENDARIO (spec §7)
-- Las dos funciones que lo sostienen viven en
-- `docs/migraciones/001-feed-calendario.sql`, con el porqué escrito:
--
--   fn_agenda_por_token(token, desde, hasta) -> jsonb
--     SECURITY DEFINER. La llama la llave `anon` desde el servidor que arma
--     el .ics, porque una app de calendario no puede autenticarse. Quien
--     autoriza es el token, validado adentro. Evita tener que sacar la llave
--     `service_role` de Supabase.
--
--   fn_regenerar_token_calendario() -> text
--     SECURITY INVOKER: exige sesión y RLS la limita a la fila del paseador.
--     Es función y no un update directo para que el token lo genere la base
--     y no se pueda escribir uno elegido a mano.
-- =========================================================
