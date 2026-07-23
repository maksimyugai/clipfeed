-- Task 35: Russian-first summaries (lazy EN translation) + article images.
-- en_generated_at: set once POST /api/admin/articles/:id/translate has
-- generated and merged the _en summary fields (see summarize.ts's
-- generateEnglishFields) — null means a RU-only summary with no EN yet.
-- image_key / image_source_url: R2 object key + original source URL for an
-- article's optional thumbnail/preview image (see images.ts) — both null
-- when no image was found/stored.
ALTER TABLE articles ADD COLUMN en_generated_at TEXT;
ALTER TABLE articles ADD COLUMN image_key TEXT;
ALTER TABLE articles ADD COLUMN image_source_url TEXT;
