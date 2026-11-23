-- Security fingerprint: policies, grants, triggers, rule-function code (spacing and comments ignored) and
-- row security for every public table. Run it on live (SQL editor) and on the drill database: the hashes must match.
select md5(string_agg(x, E'\n' order by x)) as hash, count(*) as n from (
  select 'policy '||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'') as x
    from pg_policies where schemaname='public'
  union all
  select 'grant '||table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated')
  union all
  select 'trigger '||c.relname||' '||t.tgname||' '||t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
  union all
  select 'func '||p.proname||' '||md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
  union all
  select 'rls '||relname||' '||relrowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'
) s;
