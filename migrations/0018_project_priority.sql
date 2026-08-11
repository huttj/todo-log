-- Free-text priority ("urgent but I hate it", "matters, but later this year")
-- in the user's own words; agent + briefing read it, user edits it anywhere.
ALTER TABLE projects ADD COLUMN priority TEXT;
