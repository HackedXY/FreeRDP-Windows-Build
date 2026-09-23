ALTER TABLE consultations DROP COLUMN weight_kg, DROP COLUMN temperature_c, DROP COLUMN bp_systolic,
  DROP COLUMN bp_diastolic, DROP COLUMN heart_rate, DROP COLUMN spo2;
ALTER TABLE lab_request_items DROP COLUMN result_value, DROP COLUMN result_text, DROP COLUMN abnormal;
DROP TABLE prescription_items;
