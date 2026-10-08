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
  ('Gopal'),
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