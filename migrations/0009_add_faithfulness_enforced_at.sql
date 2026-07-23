-- Task 42 Part C: persisted single-attempt cap for automatic faithfulness
-- remediation (surgical bullet-repair or one informed regeneration) -- see
-- pipeline.ts's runFaithfulnessStage. NULL means the article has never had
-- a remediation attempt spent on it; once set, a later resummarize or heal
-- cycle that reaches a 'fail' verdict again only records it, never repeats
-- repair/regeneration or the agent-archive/owner-visible decision.
ALTER TABLE articles ADD COLUMN faithfulness_enforced_at TEXT;
