<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- All data access is client-side via the generated Supabase browser client under RLS, wrapped in React Query hooks in `src/lib/queries.ts` — the schema is owned externally, so never add migrations here.
- Dates/times are converted with Intl helpers in `src/lib/tz.ts` using profiles.timezone — never use the browser's local zone for display.
- Signed-in pages live under `src/routes/_authenticated/`, whose layout also redirects un-onboarded users to /onboarding.
