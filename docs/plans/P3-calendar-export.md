# P3 — "Add to calendar" on a task

**Model: haiku.** A pure function with a well-specified format and a button. The spec is RFC
5545 and the edge cases are listed below, so there is no design work left. **Size: ~0.5h.**
**Depends on: nothing.**

## Why

A task with a due date lives only in Daily Edge. The user's day lives in their calendar. There
is no need for OAuth, a stored token, or a sync loop to bridge that for the common case — a
downloaded `.ics` file is handled natively by the default calendar app on macOS, iOS, Windows
and Android.

Explicitly **not** two-way sync. That is [P5](P5-calendar-sync.md), it needs OAuth, and it
solves a different problem (letting the planner see when you are _busy_). This is one-way,
one-click, zero infrastructure.

## Files

- `src/lib/calendar.ts` — **new.** Build the `.ics` text, trigger the download.
- `src/lib/calendar.test.ts` — **new.**
- `src/components/task-sheets.tsx` — add the button to `TaskMenuSheet`, beside Snooze.

## The format, and the traps

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Daily Edge//EN
BEGIN:VEVENT
UID:<task id>@dailyedgeapp.lovable.app
DTSTAMP:20261030T084500Z
DTSTART:20261031T033000Z
DTEND:20261031T043000Z
SUMMARY:Review the Dubai estimates
DESCRIPTION:Repo: edge-daily-flow\nNext: send to Abhishek
END:VEVENT
END:VCALENDAR
```

Five things that will be wrong if you do not do them deliberately:

1. **An all-day task must emit a DATE, not a timestamp.**
   `DTSTART;VALUE=DATE:20261031` — and `DTEND` is the _next_ day, because `DTEND` is exclusive.
   A timestamp instead lands at midnight UTC, which for an Asia/Kolkata user shows the event on
   the **wrong day**. This is the same class of bug as `parseInstant`; see
   [../decisions.md](../decisions.md#correctness).
2. **Escaping.** In `SUMMARY` and `DESCRIPTION`, a literal `\` `;` `,` must be backslash-escaped
   and a newline becomes `\n`. Task notes routinely contain commas and newlines, so an unescaped
   body produces a file that silently imports with a truncated description.
3. **CRLF line endings.** RFC 5545 requires `\r\n`. Some parsers tolerate `\n`; not all do.
4. **A stable `UID`.** Derive it from the task id, so re-exporting the same task _updates_ the
   event rather than creating a duplicate.
5. **Timed events: UTC with the `Z` suffix**, converted from the stored `due_at`. Do not emit
   local time without a `TZID` — that is the offset-less bug in a different costume.

Duration: a timed task has no end time in the schema, so default to **one hour** and keep the
constant named and commented.

## Reuse

- `partsInTz` / `dayKey` from `src/lib/tz.ts` for the all-day date in the user's timezone.
- `useProfile()` for `timezone` — never the browser's local zone.
- `ResponsiveModal` / the existing sheet pattern in `task-sheets.tsx`.

## Acceptance criteria

- A task with no `due_at` does not offer the button (there is nothing to schedule).
- `src/lib/calendar.test.ts`, ~10 cases: timed event, all-day event with exclusive `DTEND`, no
  `due_at` refused, escaping of `,` `;` `\` and newline, CRLF endings, UID stability across two
  calls, a title at the 300-char limit.
- `npm run build && npm run lint && npm test` green.

## Verification

Download from a **timed** task and an **all-day** task. Open both in a real calendar app and
confirm the all-day one lands on the correct date in IST — that is the failure this plan exists
to avoid, and a unit test cannot see it.
