CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('requester', 'manager');
CREATE TYPE incident_status AS ENUM ('open', 'under_review', 'in_progress', 'resolved', 'cancelled');
CREATE TYPE incident_priority AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(150) NOT NULL CHECK (length(btrim(name)) >= 2),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'requester',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  slug varchar(100) NOT NULL UNIQUE CHECK (slug = lower(slug)),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  assignee_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  title varchar(200) NOT NULL CHECK (length(btrim(title)) >= 3),
  description text NOT NULL CHECK (length(btrim(description)) >= 3),
  address varchar(300) NOT NULL CHECK (length(btrim(address)) > 0),
  location_details varchar(300),
  latitude numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  status incident_status NOT NULL DEFAULT 'open',
  priority incident_priority NOT NULL DEFAULT 'medium',
  solution text,
  resolved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolution_fields_match_status CHECK (
    (status = 'resolved' AND length(btrim(solution)) > 0 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status <> 'resolved' AND solution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
  )
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_key varchar(500) NOT NULL UNIQUE,
  file_name varchar(255) NOT NULL CHECK (length(btrim(file_name)) > 0),
  mime_type varchar(100) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  previous_status incident_status,
  new_status incident_status NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  observation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_status IS NULL OR previous_status <> new_status),
  CHECK (new_status <> 'cancelled' OR length(btrim(observation)) > 0)
);

CREATE TABLE assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  previous_assignee_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  new_assignee_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_assignee_id IS NULL OR previous_assignee_id <> new_assignee_id)
);

CREATE TABLE priority_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  previous_priority incident_priority NOT NULL,
  new_priority incident_priority NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_priority <> new_priority)
);

CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (comment IS NULL OR length(btrim(comment)) > 0)
);

CREATE INDEX refresh_tokens_user_expires_idx ON refresh_tokens (user_id, expires_at);
CREATE INDEX incidents_requester_created_idx ON incidents (requester_id, created_at DESC);
CREATE INDEX incidents_status_created_idx ON incidents (status, created_at DESC);
CREATE INDEX incidents_category_status_idx ON incidents (category_id, status);
CREATE INDEX incidents_priority_created_idx ON incidents (priority, created_at DESC);
CREATE INDEX incidents_assignee_status_idx ON incidents (assignee_id, status);
CREATE INDEX comments_incident_created_idx ON comments (incident_id, created_at);
CREATE INDEX attachments_incident_created_idx ON attachments (incident_id, created_at);
CREATE INDEX status_history_incident_created_idx ON status_history (incident_id, created_at);
CREATE INDEX assignment_history_incident_created_idx ON assignment_history (incident_id, created_at);
CREATE INDEX priority_history_incident_created_idx ON priority_history (incident_id, created_at);

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER status_history_append_only BEFORE UPDATE OR DELETE ON status_history
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER assignment_history_append_only BEFORE UPDATE OR DELETE ON assignment_history
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER priority_history_append_only BEFORE UPDATE OR DELETE ON priority_history
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE FUNCTION enforce_incident_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.requester_id AND role = 'requester' AND active) THEN
    RAISE EXCEPTION 'requester_id must reference an active requester' USING ERRCODE = '23514';
  END IF;
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.assignee_id AND role = 'manager' AND active
  ) THEN
    RAISE EXCEPTION 'assignee_id must reference an active manager' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.resolved_by AND role = 'manager' AND active
  ) THEN
    RAISE EXCEPTION 'resolved_by must reference an active manager' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER incidents_validate_users
BEFORE INSERT OR UPDATE OF requester_id, assignee_id, resolved_by ON incidents
FOR EACH ROW EXECUTE FUNCTION enforce_incident_users();

CREATE FUNCTION record_initial_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO status_history (incident_id, previous_status, new_status, changed_by, observation)
  VALUES (NEW.id, NULL, NEW.status, NEW.requester_id, 'Occurrence created');
  RETURN NEW;
END;
$$;

CREATE TRIGGER incidents_record_initial_status
AFTER INSERT ON incidents
FOR EACH ROW EXECUTE FUNCTION record_initial_status();

CREATE FUNCTION enforce_rating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM incidents WHERE id = NEW.incident_id AND requester_id = NEW.author_id AND status = 'resolved'
  ) THEN
    RAISE EXCEPTION 'rating author must own a resolved incident' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ratings_validate_author_and_status BEFORE INSERT OR UPDATE ON ratings
FOR EACH ROW EXECUTE FUNCTION enforce_rating();

INSERT INTO categories (name, slug) VALUES
  ('Iluminação', 'iluminacao'), ('Equipamentos', 'equipamentos'),
  ('Acessibilidade', 'acessibilidade'), ('Limpeza', 'limpeza'),
  ('Vazamento', 'vazamento'), ('Segurança', 'seguranca'),
  ('Manutenção', 'manutencao'), ('Outros', 'outros');
