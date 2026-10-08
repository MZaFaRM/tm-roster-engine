-- Sample period: Thu 8 – Sat 10 Oct 2026 (site time +04). Day 2 is a holiday, Day 3 a weekend.
INSERT INTO
  md_qual
VALUES
  ('LITHO', 'Lithography certified'),
  ('SUP', 'Supervisor');

INSERT INTO
  md_shift_tmpl
VALUES
  ('F', 2, 8),
  ('A', 6, 8),
  ('B', 10, 8),
  ('C', 14, 8),
  ('D', 18, 8),
  ('E', 22, 8);

INSERT INTO
  md_pos (pos_cd)
VALUES
  ('TECH'),
  ('OPER');

INSERT INTO
  md_pos_qual
VALUES
  (1, 'LITHO');

INSERT INTO
  md_cov_rule
VALUES
  ('SUP', 1);

INSERT INTO
  md_holiday
VALUES
  ('2026-10-09', 'Sample public holiday');

INSERT INTO
  md_emp (emp_name)
VALUES
  ('Aisha'),
  ('Ben'),
  ('Chen'),
  ('Dina'),
  ('Eli'),
  ('Fatima'),
  ('Gopal'), -- 1-7 litho
  ('Ivan'),
  ('Jamal'),
  ('Leo'),
  ('Maya'),
  ('Noor'),
  ('Omar'),
  ('Priya');

--  8-14
INSERT INTO
  md_emp_qual
VALUES
  (1, 'LITHO'),
  (1, 'SUP'),
  (2, 'LITHO'),
  (3, 'LITHO'),
  (3, 'SUP'),
  (4, 'LITHO'),
  (5, 'LITHO'),
  (6, 'LITHO'),
  (7, 'LITHO'),
  (7, 'SUP'),
  (8, 'SUP'),
  (9, 'SUP');

INSERT INTO
  td_leave (emp_id, start_at, end_at)
VALUES
  (2, '2026-10-09 00:00+04', '2026-10-10 00:00+04'), -- Ben: Day 2
  (9, '2026-10-08 00:00+04', '2026-10-09 00:00+04'), -- Jamal: Day 1
  (6, '2026-10-10 00:00+04', '2026-10-11 00:00+04'), -- Fatima: Day 3
  (13, '2026-10-08 14:00+04', '2026-10-09 10:00+04');

-- Omar: partial
-- Leo has used both flexi days this year
INSERT INTO
  td_flexi_req (
    emp_id,
    req_date,
    submitted_at,
    status,
    decided_at
  )
VALUES
  (
    10,
    '2026-02-01',
    '2026-01-15',
    'APPROVED',
    '2026-01-16'
  ),
  (
    10,
    '2026-05-20',
    '2026-05-01',
    'APPROVED',
    '2026-05-02'
  );

-- Pending requests for the holiday, in submission order
INSERT INTO
  td_flexi_req (emp_id, req_date, submitted_at)
VALUES
  (10, '2026-10-09', '2026-09-01 09:00+04'), -- Leo
  (4, '2026-10-09', '2026-09-01 10:00+04'), -- Dina
  (11, '2026-10-09', '2026-09-01 11:00+04'), -- Maya
  (5, '2026-10-09', '2026-09-01 12:00+04'), --  Eli
  (7, '2026-10-09', '2026-09-01 13:00+04');

-- Gopal