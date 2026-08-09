-- Up Migration

-- Agent scorecard (domain model §8): derived, never hand-edited, refreshed
-- by the hourly job. Composite score feeds dispatch ranking; agents with no
-- history sit at the neutral 0.5 via COALESCE at read time.

CREATE MATERIALIZED VIEW core.agent_scorecard AS
SELECT
  ap.contact_id AS agent_id,
  o.claim_rate,
  pu.punctuality,
  ns.no_show_rate,
  fb.feedback_avg,
  (COALESCE(o.claim_rate, 0.5) * 0.4
   + COALESCE(pu.punctuality, 0.5) * 0.3
   + (1 - COALESCE(ns.no_show_rate, 0)) * 0.2
   + COALESCE(fb.feedback_avg / 5.0, 0.5) * 0.1) AS score,
  now() AS computed_at
FROM core.agent_profile ap
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE state = 'claimed')::numeric
       / NULLIF(count(*) FILTER (WHERE state IN ('claimed','declined','expired')), 0) AS claim_rate
    FROM core.dispatch_offer WHERE agent_id = ap.contact_id
) o ON true
LEFT JOIN LATERAL (
  SELECT avg(CASE WHEN p.at <= lower(a.during) + interval '5 minutes' THEN 1.0 ELSE 0.0 END) AS punctuality
    FROM core.attendance_proof p
    JOIN core.appointment a ON a.id = p.appointment_id
   WHERE a.agent_id = ap.contact_id AND p.party = 'agent' AND p.direction = 'check_in'
) pu ON true
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE a.state = 'no_show' AND a.cancelled_by = 'agent')::numeric
       / NULLIF(count(*), 0) AS no_show_rate
    FROM core.appointment a WHERE a.agent_id = ap.contact_id
) ns ON true
LEFT JOIN LATERAL (
  SELECT avg((f.structured->>'condition_rating')::numeric) AS feedback_avg
    FROM core.appointment_feedback f
    JOIN core.appointment a ON a.id = f.appointment_id
   WHERE a.agent_id = ap.contact_id AND f.author_role = 'viewer'
) fb ON true;

CREATE UNIQUE INDEX agent_scorecard_agent_uq ON core.agent_scorecard (agent_id);

GRANT SELECT ON core.agent_scorecard TO crm_app, crm_readonly;

-- Down Migration

DROP MATERIALIZED VIEW core.agent_scorecard;
