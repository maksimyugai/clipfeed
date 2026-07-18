CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  canonical_url TEXT,
  title TEXT NOT NULL,
  source TEXT,
  author TEXT,
  published_at TEXT,
  added_at TEXT NOT NULL,
  added_via TEXT NOT NULL,
  lang_original TEXT,
  full_text TEXT,
  summary_ru TEXT,
  summary_en TEXT,
  tags TEXT, -- JSON array of strings
  status TEXT NOT NULL DEFAULT 'pending',
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_articles_added_at ON articles (added_at DESC);
CREATE INDEX idx_articles_status ON articles (status);
CREATE INDEX idx_articles_archived ON articles (archived);
