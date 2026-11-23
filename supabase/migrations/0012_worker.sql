-- 0012 Planning worker: the parameters and starting priors the Python worker reads that
-- earlier migrations did not seed. No new tables.

-- DDMRP shadow run (spec §8.9): which families run in shadow, and the buffer factors.
insert into public.planning_param (scope_type, scope_id, param, value, note) values
  ('global','*','ddmrp_families','["SEAL"]','Item family codes with a DDMRP shadow buffer (phase 5: sealants)'),
  ('global','*','ddmrp_lead_time_factor','0.5','DDMRP lead-time factor (red base and green zone); placeholder'),
  ('global','*','ddmrp_variability_factor','0.5','DDMRP variability factor (red safety); placeholder');

-- Uplift library starting priors (spec §9.6): one general row per mechanic type, used until a
-- campaign review has written a more specific (family, segment, depth band) row. prior_uplift
-- is a fraction of baseline in the order window. Placeholders the owner can change (§15);
-- n_obs = 1 so the first real observation moves the prior strongly.
insert into public.uplift_library (mechanic_type, family_id, segment, depth_band, prior_uplift, n_obs) values
  ('price_discount', null, null, null, 0.15, 1),
  ('volume_tier',    null, null, null, 0.10, 1),
  ('buy_x_get_y',    null, null, null, 0.20, 1),
  ('mixed_set',      null, null, null, 0.10, 1),
  ('gift_item',      null, null, null, 0.05, 1),
  ('target_rebate',  null, null, null, 0.08, 1),
  ('export_push',    null, null, null, 0.10, 1);
