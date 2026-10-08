-- Master data

CREATE TABLE md_emp (
  emp_id   SERIAL PRIMARY KEY,
  emp_name TEXT NOT NULL,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE md_qual (
  qual_cd   TEXT PRIMARY KEY,
  qual_name TEXT NOT NULL
);

CREATE TABLE md_emp_qual (
  emp_id  INT  REFERENCES md_emp ON DELETE CASCADE,
  qual_cd TEXT REFERENCES md_qual,
  PRIMARY KEY (emp_id, qual_cd)
);

-- Shifts that repeat every day
CREATE TABLE md_shift_tmpl (
  shift_cd   TEXT PRIMARY KEY,
  start_hour SMALLINT NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  len_hours  SMALLINT NOT NULL CHECK (len_hours > 0)
);

-- Positions every shift needs (one person each)
CREATE TABLE md_pos (
  pos_id SERIAL PRIMARY KEY,
  pos_cd TEXT NOT NULL UNIQUE
);

CREATE TABLE md_pos_qual (
  pos_id  INT  REFERENCES md_pos ON DELETE CASCADE,
  qual_cd TEXT REFERENCES md_qual,
  PRIMARY KEY (pos_id, qual_cd)
);

-- Quals that must be on the floor at every moment
CREATE TABLE md_cov_rule (
  qual_cd TEXT PRIMARY KEY REFERENCES md_qual,
  min_cnt SMALLINT NOT NULL CHECK (min_cnt > 0)
);

CREATE TABLE md_holiday (
  hol_date DATE PRIMARY KEY,
  hol_name TEXT NOT NULL
);

-- Transaction data

CREATE TABLE td_leave (
  leave_id   SERIAL PRIMARY KEY,
  emp_id     INT NOT NULL REFERENCES md_emp ON DELETE CASCADE,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ NOT NULL,
  leave_type TEXT NOT NULL DEFAULT 'LEAVE' CHECK (leave_type IN ('LEAVE', 'FLEXI')),
  CHECK (end_at > start_at)
);
CREATE INDEX td_leave_emp_time ON td_leave (emp_id, start_at);

CREATE TABLE td_flexi_req (
  req_id       SERIAL PRIMARY KEY,
  emp_id       INT NOT NULL REFERENCES md_emp ON DELETE CASCADE,
  req_date     DATE NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'DEFERRED', 'REVIEW')),
  reason       TEXT,
  decided_at   TIMESTAMPTZ
);

CREATE TABLE td_roster_run (
  run_id        SERIAL PRIMARY KEY,
  period_start  DATE NOT NULL,
  days          SMALLINT NOT NULL,
  status        TEXT NOT NULL,
  used_fallback BOOLEAN NOT NULL,
  duration_ms   INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE td_assign (
  assign_id SERIAL PRIMARY KEY,
  run_id    INT NOT NULL REFERENCES td_roster_run ON DELETE CASCADE,
  emp_id    INT NOT NULL REFERENCES md_emp,
  pos_id    INT NOT NULL REFERENCES md_pos,
  start_at  TIMESTAMPTZ NOT NULL,
  end_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE td_gap (
  gap_id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES td_roster_run ON DELETE CASCADE,
  descr  TEXT NOT NULL
);
