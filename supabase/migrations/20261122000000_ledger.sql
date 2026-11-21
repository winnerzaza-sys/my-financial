-- Rows are exposed only through owner-checked RPCs for writes.
create schema if not exists financial_private;
revoke all on schema financial_private from public, anon, authenticated;

create sequence financial_private.ledger_sequence as bigint;

create table public.ledger_rows (
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity text not null,
  id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision integer not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  seq bigint not null default nextval('financial_private.ledger_sequence'),
  primary key (owner_id, entity, id),
  check (length(id) between 1 and 100),
  check (octet_length(data::text) <= 48000)
) partition by list (entity);

create table public.chat_rooms partition of public.ledger_rows for values in ('room');
create table public.chat_messages partition of public.ledger_rows for values in ('message');
create table public.transactions partition of public.ledger_rows for values in ('transaction');
create table public.monthly_budgets partition of public.ledger_rows for values in ('budget');
create table public.message_transactions partition of public.ledger_rows for values in ('link');
create index ledger_cursor on public.ledger_rows(owner_id,seq);

create table financial_private.operations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  result jsonb not null,
  primary key(owner_id,id)
);

do $$
declare rel text;
begin
  foreach rel in array array['ledger_rows','chat_rooms','chat_messages','transactions','monthly_budgets','message_transactions']
  loop
    execute format('alter table public.%I enable row level security',rel);
    execute format('revoke all on public.%I from public, anon, authenticated',rel);
    execute format('grant select on public.%I to authenticated',rel);
    execute format('create policy owner_reads on public.%I for select to authenticated using ((select auth.uid()) = owner_id)',rel);
  end loop;
end;
$$;
alter table financial_private.operations enable row level security;

create function financial_private.to_wire(r public.ledger_rows) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',r.id,'entity',r.entity,'data',r.data,'revision',r.revision,
    'createdAt',r.created_at,'updatedAt',r.updated_at,'deletedAt',r.deleted_at);
$$;

create function financial_private.require_owner(requested_owner uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or actor is distinct from requested_owner then
    raise exception 'account mismatch' using errcode = '42501';
  end if;
  return actor;
end;
$$;

create function public.ledger_apply(requested_owner uuid, operation_id uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := financial_private.require_owner(requested_owner);
  entry jsonb;
  wire jsonb;
  payload jsonb;
  saved public.ledger_rows;
  prior public.ledger_rows;
  row_id text;
  row_entity text;
  expected integer;
  result_rows jsonb := '[]'::jsonb;
  response jsonb;
begin
  if operation_id is null or jsonb_typeof(changes) is distinct from 'array'
    or jsonb_array_length(changes) not between 1 and 1500 or octet_length(changes::text) > 4000000 then
    raise exception 'invalid operation' using errcode = '22023';
  end if;
  -- The per-owner lock orders commits for each owner's pull cursor.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,0));
  select o.result into response from financial_private.operations o where o.owner_id=actor and o.id=operation_id;
  if found then return response; end if;

  if exists (
    select 1 from jsonb_array_elements(changes) as c
    group by c->'row'->>'id' having count(*) > 1
  ) then raise exception 'duplicate row in operation' using errcode = '22023'; end if;

  for entry in select value from jsonb_array_elements(changes) loop
    wire := entry->'row';
    row_id := wire->>'id';
    row_entity := wire->>'entity';
    expected := (entry->>'expected')::integer;
    if row_id is null or row_entity is null or row_entity not in ('room','message','transaction','budget','link')
      or expected is null or expected < 0 or (wire->>'revision')::integer is distinct from expected+1
      or (row_entity in ('message','transaction','link') and row_id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    select * into prior from public.ledger_rows where owner_id=actor and entity=row_entity and id=row_id;
    if row_entity='room' and expected=0 and prior.revision=1 and prior.deleted_at is null and prior.data=wire->'data' then
      continue;
    end if;
    if coalesce(prior.revision,0) <> expected then
      return jsonb_build_object('status','conflict','rows','[]'::jsonb);
    end if;
  end loop;

  for entry in
    select value from jsonb_array_elements(changes)
    order by case value->'row'->>'entity' when 'room' then 0 when 'link' then 2 else 1 end
  loop
    wire := entry->'row';
    payload := wire->'data';
    row_id := wire->>'id';
    row_entity := wire->>'entity';
    expected := (entry->>'expected')::integer;

    if row_entity='room' then
      if (payload->>'range') not in ('day','week','month') or payload->>'key' is distinct from (payload->>'range')||':'||(payload->>'start')
        or row_id is distinct from 'room:'||(payload->>'key') or (payload->>'start') !~ '^\d{4}-\d{2}-\d{2}$'
        or wire->>'deletedAt' is not null or expected<>0 then
        raise exception 'invalid room' using errcode = '22023';
      end if;
      select * into prior from public.ledger_rows where owner_id=actor and entity='room' and id=row_id;
      if found then
        result_rows := result_rows||jsonb_build_array(financial_private.to_wire(prior));
        continue;
      end if;
    elsif row_entity='message' then
      if coalesce(payload->>'role','') not in ('user','assistant') or jsonb_typeof(payload->'text') is distinct from 'string'
        or length(payload->>'text')>1000 or not exists (
          select 1 from public.ledger_rows where owner_id=actor and entity='room' and id=payload->>'roomId' and deleted_at is null
        ) then raise exception 'invalid room reference/message' using errcode = '23503'; end if;
    elsif row_entity='link' then
      if expected<>0 or jsonb_typeof(payload->'revision') is distinct from 'number' or not exists (
        select 1 from public.ledger_rows where owner_id=actor and entity='message' and id=payload->>'messageId'
      ) or not exists (
        select 1 from public.ledger_rows where owner_id=actor and entity='transaction' and id=payload->>'transactionId'
      ) then raise exception 'invalid link' using errcode = '23503'; end if;
    elsif row_entity='transaction' then
      if coalesce(length(trim(payload->>'name')),0) not between 1 and 160
        or coalesce(payload->>'type','') not in ('expense','income','refund','transfer','card_payment','top_up','wallet_spend')
        or jsonb_typeof(payload->'counted') is distinct from 'boolean'
        or ((payload->>'type')='transfer' and (payload->>'counted')::boolean)
        or coalesce(payload->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
        or ((payload->>'date')::date)::text is distinct from payload->>'date'
        or jsonb_typeof(payload->'amount') is distinct from 'number'
        or coalesce(payload->>'category','') not in (
          'อาหารและเครื่องดื่ม','กีฬา › แบดมินตัน','เติมเงินเข้าแอป › เซเว่น','เติมเงินเข้าแอป › ทางด่วน',
          'เติมเงินเข้าแอป › Starbucks','เติมเงินเข้าแอป › แอปอื่น ๆ','จ่ายบัตรเครดิต › ttb','จ่ายบัตรเครดิต › KBank',
          'จ่ายบัตรเครดิต › กรุงศรี','จ่ายบัตรเครดิต › อื่น ๆ','เติมน้ำมัน','หาหมอ','อื่น ๆ','ไม่ระบุหมวด')
        or coalesce(payload->>'method','') not in ('ไม่ระบุ','เงินสด','โอน','บัตร ttb','บัตร KBank','บัตรกรุงศรี','บัตรเครดิต','ยอดเติมในแอป')
        or coalesce(payload->>'amount','') !~ '^[1-9][0-9]*$' or (payload->>'amount')::numeric > 9007199254740991 then
        raise exception 'invalid transaction' using errcode = '22023';
      end if;
    elsif row_entity='budget' then
      if coalesce(payload->>'month','') !~ '^\d{4}-(0[1-9]|1[0-2])-01$'
        or row_id is distinct from 'budget:'||(payload->>'month')
        or coalesce(payload->>'amount','') !~ '^[0-9]+$' or (payload->>'amount')::numeric > 9007199254740991 then
        raise exception 'invalid budget' using errcode = '22023';
      end if;
    end if;
    insert into public.ledger_rows(owner_id,entity,id,data,revision,created_at,updated_at,deleted_at)
      values(actor,row_entity,row_id,payload,expected+1,(wire->>'createdAt')::timestamptz,now(),(wire->>'deletedAt')::timestamptz)
      on conflict (owner_id,entity,id) do update
        set data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at,
            deleted_at=excluded.deleted_at,seq=excluded.seq
      returning * into saved;
    result_rows := result_rows||jsonb_build_array(financial_private.to_wire(saved));
  end loop;
  response := jsonb_build_object('status','ok','rows',result_rows);
  insert into financial_private.operations(owner_id,id,result) values(actor,operation_id,response);
  return response;
end;
$$;

create function public.ledger_pull(requested_owner uuid, after_cursor bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := financial_private.require_owner(requested_owner);
  result jsonb;
begin
  select jsonb_build_object('rows',coalesce(jsonb_agg(financial_private.to_wire(r.row_data) order by r.seq),'[]'::jsonb),
    'cursor',coalesce(max(r.seq),after_cursor)::text)
    into result
    from (select source as row_data, source.seq from public.ledger_rows as source
      where owner_id=actor and seq>after_cursor order by seq limit 100) as r;
  return result;
end;
$$;

revoke all on function public.ledger_apply(uuid,uuid,jsonb), public.ledger_pull(uuid,bigint) from public, anon, authenticated;
grant execute on function public.ledger_apply(uuid,uuid,jsonb), public.ledger_pull(uuid,bigint) to authenticated;
