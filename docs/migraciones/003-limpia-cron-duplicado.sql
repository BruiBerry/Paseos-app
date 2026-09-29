-- ---------------------------------------------------------
-- 003 · Limpia lo que dejó una sesión paralela de Claude web
--
-- Una sesión en la nube hizo su propia versión de la 002 (cron de
-- materialización y cierre) desde un punto anterior a la nuestra. Aplicada
-- junto a `002-cierre-y-materializacion.sql`, dejaba dos sistemas cerrando
-- y materializando a la vez, y el cierre duplicado corría cada 15 minutos
-- sin los `nullif(x, 0)` de la cascada: un `duracion_min = 0` cerraría el
-- paseo con duración cero y marcaría sus perros como completados.
--
-- Solo hace falta correrla si esa migración paralela llegó a aplicarse.
-- Los jobs y funciones que quedan son los de la 002: `materializar-diario`,
-- `cerrar-olvidados` y las `fn_*_todos`.
-- ---------------------------------------------------------

-- `unschedule` falla si el job no existe; se ignora para poder correrla
-- dos veces sin romperse.
do $$
begin
  perform cron.unschedule('materializar-recurrentes-diario');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('cerrar-paseos-olvidados');
exception when others then null;
end $$;

drop function if exists fn_materializar_recurrentes(integer);
drop function if exists fn_cerrar_paseos_olvidados();
drop function if exists fn_duracion_paseo(uuid);
