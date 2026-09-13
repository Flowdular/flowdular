-- The indexes carry no data of their own, so dropping them loses nothing; the
-- lists stay correct and pay a sort per page.
DROP INDEX IF EXISTS notifications_deliveries_page_idx;
DROP INDEX IF EXISTS notifications_webhook_subscriptions_page_idx;
DROP INDEX IF EXISTS notifications_inbox_member_page_idx;
