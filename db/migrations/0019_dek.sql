-- Up Migration

-- Data-encryption keys for field-level encryption, sealed under the
-- KMS-held master key. Deleting a row IS crypto-shredding: every
-- ciphertext (and every backup of it) becomes unreadable at once.
CREATE TABLE privacy.dek (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_ciphertext bytea NOT NULL,
  iv             bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE privacy.dek;
