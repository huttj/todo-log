-- Dismissals fold into the briefing row as JSON ({day: [{key,label}]}),
-- replacing the short-lived dismissals table.
ALTER TABLE briefings ADD COLUMN dismissed_json TEXT;
DROP TABLE dismissals;
