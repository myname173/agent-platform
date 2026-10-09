-- 清理探针账号（本会话为验证「登录后界面是否深色」临时创建，邮箱 probe-check@invalid.local）
-- 只按这一个 user id 删除，绝不影响真实账号。
\set probe 'user_kJWjzd61rKJB2CBsfcbzZgDs6cr'

DO $$
DECLARE
  r record;
  n bigint;
  total bigint := 0;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('user_id', 'userId')
    ORDER BY table_name
  LOOP
    EXECUTE format('DELETE FROM %I WHERE %I = $1', r.table_name, r.column_name)
      USING 'user_kJWjzd61rKJB2CBsfcbzZgDs6cr';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE NOTICE 'deleted % from %', n, r.table_name;
      total := total + n;
    END IF;
  END LOOP;
  RAISE NOTICE 'TOTAL deleted = %', total;
END $$;

DELETE FROM users WHERE id = 'user_kJWjzd61rKJB2CBsfcbzZgDs6cr';
SELECT count(*) AS probe_users_left FROM users WHERE email = 'probe-check@invalid.local';
SELECT count(*) AS real_users_left FROM users;
