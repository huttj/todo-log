-- "scheduled" stops being a todo status: work state (idea/in_progress/done/
-- abandoned) and time commitments (todo_schedules slots) are separate axes.
-- Existing scheduled rows revert to idea; their slots carry the scheduling.
UPDATE todos SET status = 'idea' WHERE status = 'scheduled';
