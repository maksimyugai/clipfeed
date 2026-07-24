-- Task 46 Part C: pixel dimensions of an article's stored preview image,
-- parsed from the PNG/JPEG/WebP header bytes at download time (see
-- packages/api/src/pipeline/image-dimensions.ts). Both null whenever
-- image_key is null, or when the format wasn't recognized/bytes were
-- truncated — used to emit og:image:width/og:image:height on GET /a/:id so
-- link-preview crawlers render the image more reliably.
ALTER TABLE articles ADD COLUMN image_width INTEGER;
ALTER TABLE articles ADD COLUMN image_height INTEGER;
