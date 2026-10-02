-- VWFS hereda el vendedor de su F01 (formularios_vwfs.f01_id).
-- El F01 lo completa forms-gateway desde Oversoft; acá se replica al VWFS.
-- Nunca pisa un vendedor puesto a mano en el VWFS: solo llena vacíos o
-- acompaña un cambio del F01 si el VWFS tenía el mismo vendedor que el F01.

-- 1) Al crear el VWFS (o vincularlo a otro F01) sin vendedor → toma el del F01.
create or replace function public.vwfs_vendedor_desde_f01()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.vendedor is null and new.f01_id is not null then
    select f.vendedor into new.vendedor from formularios_f01 f where f.id = new.f01_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_vwfs_vendedor_desde_f01 on public.formularios_vwfs;
create trigger trg_vwfs_vendedor_desde_f01
  before insert or update of f01_id on public.formularios_vwfs
  for each row execute function public.vwfs_vendedor_desde_f01();

-- 2) Cuando el F01 recibe/cambia vendedor → lo replica a sus VWFS.
create or replace function public.f01_vendedor_a_vwfs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.vendedor is not null and new.vendedor is distinct from old.vendedor then
    update formularios_vwfs v
       set vendedor = new.vendedor
     where v.f01_id = new.id
       and (v.vendedor is null or v.vendedor = old.vendedor);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_f01_vendedor_a_vwfs on public.formularios_f01;
create trigger trg_f01_vendedor_a_vwfs
  after update of vendedor on public.formularios_f01
  for each row execute function public.f01_vendedor_a_vwfs();

revoke all on function public.vwfs_vendedor_desde_f01() from public, anon, authenticated;
revoke all on function public.f01_vendedor_a_vwfs() from public, anon, authenticated;

-- 3) Carga de lo que ya existe (una sola vez).
update public.formularios_vwfs v
   set vendedor = f.vendedor
  from public.formularios_f01 f
 where v.f01_id = f.id
   and v.vendedor is null
   and f.vendedor is not null;
