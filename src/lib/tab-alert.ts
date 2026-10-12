// "You have unread reminders" for a tab that isn't in front: a flashing title and a
// counter drawn onto the favicon. Both are reversible — clearTabAlert() puts the document
// back exactly as it was, because the router owns the title and the markup owns the icon.

/** How fast the title alternates. Slow enough to read both halves. */
const FLASH_MS = 1200;

type State = {
  timer: ReturnType<typeof setInterval>;
  /** The title the router last set, which is what we restore and flash back to. */
  base: string;
  alert: string;
  showingAlert: boolean;
};

let state: State | null = null;
/** The icon href from the document head, captured before the first badge is drawn. */
let originalIcon: string | null = null;

function iconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

/**
 * Flash "(n) ⏰ Daily Edge" against the page's own title, and badge the favicon with n.
 * Idempotent per count: calling it again with the same count does nothing, so it can live
 * in a render-driven effect.
 */
export function setTabAlert(count: number): void {
  if (typeof document === "undefined") return;
  if (count <= 0) return clearTabAlert();

  const alert = `(${count}) ⏰ Daily Edge`;
  if (state) {
    if (state.alert === alert) return;
    state.alert = alert;
    if (state.showingAlert) document.title = alert;
  } else {
    const base = document.title;
    const timer = setInterval(() => {
      if (!state) return;
      // Re-read the router's title whenever it is neither of ours: navigating while the
      // alert is up should update what we flash back to, not get overwritten forever.
      if (document.title !== state.alert && document.title !== state.base) {
        state.base = document.title;
      }
      state.showingAlert = !state.showingAlert;
      document.title = state.showingAlert ? state.alert : state.base;
    }, FLASH_MS);
    state = { timer, base, alert, showingAlert: true };
    document.title = alert;
  }

  drawBadge(count);
}

/** Stop flashing, restore the title the router set, and put the plain favicon back. */
export function clearTabAlert(): void {
  if (typeof document === "undefined") return;
  if (state) {
    clearInterval(state.timer);
    document.title = state.base;
    state = null;
  }
  const link = iconLink();
  if (link && originalIcon !== null) link.href = originalIcon;
}

/**
 * Redraw the favicon with a count bubble. Canvas rather than a set of pre-made PNGs so
 * the number is real at any value; a 32px canvas is the largest size a tab strip uses.
 */
function drawBadge(count: number): void {
  const link = iconLink();
  if (!link) return;
  if (originalIcon === null) originalIcon = link.getAttribute("href") ?? "/favicon.png";

  const img = new Image();
  img.onload = () => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) return;

    g.drawImage(img, 0, 0, size, size);

    const label = count > 9 ? "9+" : String(count);
    const r = size * 0.33;
    const cx = size - r;
    const cy = r;

    // A ring in the page background colour, so the bubble reads as sitting on top of the
    // icon rather than being part of it at 16px.
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = "#0B0B0F";
    g.fill();
    g.beginPath();
    g.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
    g.fillStyle = "#EF4444";
    g.fill();

    g.fillStyle = "#FFFFFF";
    g.font = `bold ${Math.round(r * (label.length > 1 ? 0.95 : 1.25))}px -apple-system, system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, cx, cy + 1);

    link.href = canvas.toDataURL("image/png");
  };
  // A failed load just leaves the plain favicon in place; the title flash still carries it.
  img.onerror = () => {};
  img.src = originalIcon;
}
