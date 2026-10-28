-- Up Migration
CREATE TABLE analytics_daily (
  day date NOT NULL,
  doctor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  consultations_total int NOT NULL DEFAULT 0,
  completed int NOT NULL DEFAULT 0,
  cancelled int NOT NULL DEFAULT 0,
  no_show int NOT NULL DEFAULT 0,
  revenue_minor bigint NOT NULL DEFAULT 0,
  refunds_minor bigint NOT NULL DEFAULT 0,
  new_patients int NOT NULL DEFAULT 0,
  avg_lead_hours numeric(8,2),
  PRIMARY KEY (day, doctor_id)
);

-- Down Migration
DROP TABLE IF EXISTS analytics_daily;