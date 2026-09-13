-- The three list screens page by keyset over their sort column and the id, both
-- in one direction, and the direction the reader asks for may be either. An
-- index that mixes directions, such as the member status index on
-- (created_at DESC, id), serves neither walk without a sort. Each index here
-- carries the scope of its list, then the sort column, then the id, all
-- ascending, so a page is a range read and the descending walk is the same
-- index read backwards.
CREATE INDEX IF NOT EXISTS notifications_inbox_member_page_idx
  ON notifications_inbox (tenant_id, recipient_account_id, created_at, id);
CREATE INDEX IF NOT EXISTS notifications_webhook_subscriptions_page_idx
  ON notifications_webhook_subscriptions (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_page_idx
  ON notifications_deliveries (tenant_id, scheduled_for, id);
