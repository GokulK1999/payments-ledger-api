ALTER TABLE accounts ADD COLUMN allow_negative BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN request_hash TEXT;
INSERT INTO accounts (name, currency, allow_negative) VALUES ('External Funding', 'MYR', true);
