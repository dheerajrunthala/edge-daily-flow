import { SORTS, TASK_SOURCES, type SortKey } from "./task-logic";
import { csvToList, listToCsv, strOrUndef } from "./view-prefs";

/**
 * The Tasks page's view, as it lives in the query string: sort, filters, search and
 * list/calendar. A filtered list is a thing you text yourself, and it has to survive a
 * refresh.
 *
 * Every field is optional and a value equal to the default is *dropped* on the way in,
 * which does two things: a plain /tasks stays a plain URL carrying only what you really
 * changed, and `<Link to="/tasks">` elsewhere in the app does not have to supply a
 * search object to satisfy the type.
 */
export type TasksSearch = {
  view?: "list" | "calendar" | undefined;
  sort?: SortKey | undefined;
  status?: "todo" | "done" | "all" | undefined;
  mode?: "and" | "or" | undefined;
  /** Comma-joined tag names; the URL is the thing a person reads, so keep it flat. */
  tags?: string | undefined;
  src?: string | undefined;
  q?: string | undefined;
  month?: string | undefined;
};

export const SORT_KEYS: readonly SortKey[] = SORTS.map((s) => s.key);
export const SOURCE_KEYS: readonly string[] = TASK_SOURCES.map((s) => s.key);

/** Also the normalizer on the way out: patch, re-parse, navigate. */
export function parseTasksSearch(raw: Record<string, unknown>): TasksSearch {
  const s: TasksSearch = {};
  if (raw["view"] === "calendar") s.view = "calendar";
  const sort = raw["sort"];
  if (typeof sort === "string" && sort !== "due" && SORT_KEYS.includes(sort as SortKey))
    s.sort = sort as SortKey;
  const status = raw["status"];
  if (status === "done" || status === "all") s.status = status;
  const tags = listToCsv(csvToList(raw["tags"]));
  if (tags) s.tags = tags;
  // AND/OR means nothing below two tags, so it is not worth carrying.
  if (raw["mode"] === "or" && csvToList(tags).length > 1) s.mode = "or";
  const src = listToCsv(csvToList(raw["src"]).filter((x) => SOURCE_KEYS.includes(x)));
  if (src) s.src = src;
  const q = strOrUndef(raw["q"]);
  if (q) s.q = q;
  const month = strOrUndef(raw["month"]);
  if (month && /^\d{4}-\d{2}$/.test(month)) s.month = month;
  return s;
}
