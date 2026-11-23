-- =====================================================================
-- GOLDEN ERP — Migration 018: sign in with a username
--   Many staff (cashiers, warehouse, drivers) have no e-mail. Every user gets
--   a username (unique in the company); e-mail becomes optional. Existing
--   users get the part of their e-mail before "@" (when free), and so does
--   any user created later without one. Non-destructive: no data removed.
-- =====================================================================

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN username citext;

UPDATE users u SET username = x.cand
  FROM (SELECT id, cand, row_number() OVER (PARTITION BY tenant_id, cand ORDER BY created_at) AS rn
          FROM (SELECT id, tenant_id, created_at, lower(regexp_replace(split_part(email::text, '@', 1), '[^A-Za-z0-9._-]', '', 'g')) AS cand FROM users WHERE email IS NOT NULL) c) x
 WHERE x.id = u.id AND x.rn = 1 AND length(x.cand) BETWEEN 2 AND 40;

ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (username IS NULL OR username::text ~ '^[A-Za-z0-9._-]{2,40}$');
ALTER TABLE users ADD CONSTRAINT users_login_identity CHECK (email IS NOT NULL OR username IS NOT NULL);
CREATE UNIQUE INDEX uq_users_username ON users (tenant_id, username) WHERE username IS NOT NULL;

-- a user inserted without a username gets the e-mail's local part when it is free in the company
CREATE OR REPLACE FUNCTION trg_users_default_username() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cand text;
BEGIN
  IF NEW.username IS NULL AND NEW.email IS NOT NULL THEN
    cand := lower(regexp_replace(split_part(NEW.email::text, '@', 1), '[^A-Za-z0-9._-]', '', 'g'));
    IF length(cand) BETWEEN 2 AND 40 AND NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = NEW.tenant_id AND username = cand::citext) THEN
      NEW.username := cand;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_users_username BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION trg_users_default_username();
