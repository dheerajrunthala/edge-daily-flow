# Edge Daily Flow

Build "Daily Edge" — an AI-powered productivity + news app open to anyone who signs up. My Supabase project is connected and ALL TABLES ALREADY EXIST. Do NOT create, alter, or migrate any tables, and do not create edge functions. Use the generated Supabase types and only read/write the existing tables. A database trigger already creates each new user's profiles row, news_prefs row, and 6 default tags on signup.

## Design direction
Calm, premium, focused — Linear meets Things 3, with an editorial news section.
- Fonts: "Inter" for UI; "Newsreader" (serif) for news headlines and the daily summary.
- Palette: neutral zinc base with a single indigo accent, used for primary actions and anything AI-generated. AI content gets a small sparkle icon and a soft indigo gradient border.
- Light and dark mode: follow the system, with a manual toggle. Dark background is near-black (#0B0B0F).
- Tag chips use the color token in tags.color (slate, blue, green, amber, rose, violet, cyan, orange) as a soft tinted background with matching text, readable in both themes.
- Generous whitespace, 12–16px radius cards, hairline borders, minimal shadows, 150–200ms transitions. Skeleton loaders for all data, and friendly empty states (icon + one-line hint).
- Fully responsive:
  - Desktop (≥1024px): collapsible left sidebar, content max-width ~1100px, two-column brief.
  - Mobile: bottom tab bar (Brief, Tasks, News, Insights, Settings), single-column cards, a floating "+" button for new tasks, bottom sheets instead of dialogs, 44px minimum touch targets.
- Installable PWA (manifest, icons, standalone display, theme color).

## Public pages
- Landing (/), shown when logged out: a hero line "Your day, distilled by AI." with a short subline about AI-organized tasks and a personalized daily news brief in your inbox. Three feature cards (Natural-language tasks, Daily AI news digest, Morning email brief), a stylized product preview mock, and a "Get started" CTA. Logged-in users are redirected to /brief.
- Login (/login): email magic link on a clean centered card, with a "check your inbox" state.

## Onboarding (/onboarding)
Shown after login when profiles.onboarded_at is null. A 3-step flow with a progress indicator:
1. Name + timezone (auto-detect from the browser, editable searchable select) → profiles.full_name, profiles.timezone.
2. Interests: news categories as selectable cards (AI, Software Development, Indian Stock Market, Indian Startups & Tech, Global Tech, Policy & Regulation), a headline count 10/20/30 segmented control, and an "About you" textarea → news_prefs.categories, news_prefs.headline_count, profiles.news_profile. Prefill the textarea with an example: "Software engineer in India interested in AI, backend, and markets".
3. Email brief times (default 08:00 and 10:00, add/remove times, shown in the user's timezone) → news_prefs.email_times.
On finish, set profiles.onboarded_at = now() and go to /brief.

## App pages (authenticated)
1. Brief (/brief): greeting with name and today's date in the user's timezone. A "Today at a glance" card with the latest digests.summary in serif. Sections: Today's tasks, Overdue (rose accent), Birthdays in the next 7 days (tasks tagged "Birthday"), Top 5 headlines from the latest digest.
2. Tasks (/tasks): List and Calendar (month) views. Group the list as Overdue / Today / Upcoming / Someday (no due date). Filter by tag and status. Checking a task: if recurrence = 'none', set status 'done' and completed_at; if recurring, insert into task_completions (with the occurrence's due_at) and move due_at to the next occurrence. Create/edit in a dialog (bottom sheet on mobile) with title, notes, due date + time or all-day, recurrence, priority, tags (multi-select from the tags table, plus "create tag" with a color picker), and remind before (none / 15 min / 1 hour / 1 day / 3 days). At the top, an AI quick-add bar with a sparkle icon and placeholder "Try: call Rahul next Tue 3pm #office, mom's birthday 14 Nov every year". Submit calls supabase.functions.invoke('parse-task', { body: { text } }) and shows the returned tasks in an editable preview before saving them with source = 'ai'. Add a TODO comment because the function is built later, and show a "coming soon" toast if the call fails. Open the quick-add with ⌘K / Ctrl+K.
3. News (/news): date picker over digests. Items grouped by category. Each card: serif headline, summary, a "Why it matters" line in muted indigo, source + relative time, an external-link button (new tab), a bookmark toggle (updates only news_items.is_saved), and a "Follow-up" badge when related_item_id is set, which opens the earlier item. A "Saved" tab lists bookmarked items. Empty state: "Your first digest arrives tomorrow morning."
4. Insights (/insights): stat cards for articles scanned (sum of digests.sources_scanned), estimated reading time saved (3 min per article), tasks created by AI (tasks.source = 'ai'), and on-time completion rate, plus a 30-day bar chart of completions from task_completions (recharts).
5. Settings (/settings): name, timezone, "About you" (with a note that it personalizes news ranking), categories, headline count, email times, digest on/off switch, manage tags (rename, recolor, delete), theme toggle, sign out.

## Technical
React Query for all data fetching, with optimistic updates for task toggles. Show all dates and times in the user's profiles.timezone. Route guards: logged out → landing/login; not onboarded → /onboarding.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://edge-daily-flow.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/65ec949b-f1a1-46cb-864b-dab60ad79377).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
