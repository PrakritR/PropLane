-- Production drifted: public.profiles.phone was numeric there while dev/staging (and every function that writes it)
-- use text. phone_auth_bind inserts the E.164 text and failed with 42804 on production, so no phone could be verified
-- or signed in. Lossless: numeric digits become the same digits as text. No-op where the column is already text.
do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone') = 'numeric' then
    alter table public.profiles alter column phone type text using phone::text;
  end if;
end $$;
