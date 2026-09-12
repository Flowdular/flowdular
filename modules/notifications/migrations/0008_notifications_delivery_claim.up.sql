-- Two processes drain the same queue during a rolling update, and both see the
-- same due row. The row is claimed under its own tenant before the request
-- leaves: the winner moves it to 'sending' and stamps the claim, the loser's
-- update matches nothing and it moves on, so one pending attempt is one request.
--
-- The claim is a lease, not a ledger outcome. It leaves the attempt number, the
-- response and the error class untouched, and a claim older than the request
-- timeout plus its grace is taken over again so a process that died mid-send
-- strands nothing. 'sending' is why the routing page advances instead of
-- returning the rows another process is already holding.
--
-- The cross-tenant poll is the one that has to find a stranded claim, so
-- claimed_at joins the routing columns the background role may read. It carries
-- a clock reading and nothing about the tenant, the subscription or the payload.
ALTER TABLE notifications_deliveries ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_status_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_status_check
  CHECK (status IN ('pending', 'sending', 'succeeded', 'failed', 'dead-letter'));
GRANT SELECT (claimed_at) ON notifications_deliveries TO coreloom_background;
