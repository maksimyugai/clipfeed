-- Named telegram_published_at (not published_at) because published_at
-- already exists (migration 0001) meaning the source article's own
-- publish date, extracted from the page — a different thing entirely from
-- when ClipFeed posted this article to Telegram's drip channel/DM.
ALTER TABLE articles ADD COLUMN telegram_published_at TEXT;
