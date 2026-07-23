-- Task 41 Part C: distinguishes "waiting in the queue" from "actually
-- running the pipeline" for the stale-pending sweeper, which used to measure
-- everything from added_at — punishing an article for queue backlog wait
-- time it never caused (see db.ts's sweepStalePending and its two-branch
-- split). Set as the consumer's first action (see index.ts's queue()
-- handler), alongside its queue_received log; NULL means the message hasn't
-- reached a consumer invocation yet; cleared back to NULL by
-- markArticlePending so a retry/resummarize's own wait is measured fresh,
-- not against a stale timestamp from a previous attempt.
ALTER TABLE articles ADD COLUMN processing_started_at TEXT;
