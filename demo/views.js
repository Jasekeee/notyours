// Server-rendered HTML. Every interpolated value goes through esc().

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CSS = `
:root {
  --bg: #f7f6f3; --card: #ffffff; --ink: #1f2328; --muted: #6b6f76; --line: #e6e3dd;
  --accent: #2f6f5e; --accent-ink: #ffffff; --pro: #8a5a00; --pro-bg: #fff4dc; --danger: #b42318;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { background: var(--card); border-bottom: 1px solid var(--line); }
.bar { max-width: 760px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 19px; color: var(--ink); letter-spacing: -0.01em; }
.brand span { color: var(--accent); }
nav { display: flex; gap: 16px; flex-wrap: wrap; flex: 1; }
nav a { color: var(--muted); font-size: 15px; }
nav a.on { color: var(--ink); font-weight: 600; }
.who { color: var(--muted); font-size: 14px; }
main { max-width: 760px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 18px; letter-spacing: -0.015em; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; margin-bottom: 14px; }
.notes { list-style: none; padding: 0; margin: 0; }
.notes li a { display: block; color: inherit; }
.notes li a:hover { text-decoration: none; border-color: var(--accent); }
.notes h2 { font-size: 17px; margin: 0 0 4px; }
.preview { color: var(--muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
.body { white-space: pre-wrap; font-size: 17px; margin: 0; }
form.stack { display: grid; gap: 14px; }
label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }
input, textarea { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); width: 100%; }
textarea { min-height: 140px; resize: vertical; }
input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
button, .btn { font: inherit; font-weight: 600; background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; display: inline-block; }
button:hover, .btn:hover { filter: brightness(1.08); text-decoration: none; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
.row h1 { margin: 0; }
.badge { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: #eef3f1; color: var(--accent); vertical-align: middle; }
.badge.pro { background: var(--pro-bg); color: var(--pro); }
.error { color: var(--danger); background: #fdecea; border-radius: 8px; padding: 10px 12px; margin: 0; }
.empty { color: var(--muted); text-align: center; padding: 36px; }
dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.narrow { max-width: 420px; margin: 0 auto; }
.muted { color: var(--muted); }
`;

/**
 * @param {{ title: string, user?: { email: string, plan: string } | null, active?: string, body: string }} p
 */
export function page({ title, user, active = '', body }) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;
  const nav = user
    ? [link('/notes', 'Notes', 'notes'), link('/notes/new', 'New note', 'new'), link('/pro/export', 'Export', 'export'), link('/account', 'Account', 'account'), link('/logout', 'Log out', 'logout')].join('')
    : [link('/login', 'Log in', 'login'), link('/signup', 'Sign up', 'signup')].join('');
  const who = user ? `<span class="who">${esc(user.email)} ${planBadge(user.plan)}</span>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Jotter</title>
<style>${CSS}</style>
</head>
<body>
<header><div class="bar"><a class="brand" href="/">Jot<span>ter</span></a><nav>${nav}</nav>${who}</div></header>
<main>
${body}
</main>
</body>
</html>`;
}

export function planBadge(plan) {
  return plan === 'pro' ? '<span class="badge pro">PRO</span>' : '<span class="badge">FREE</span>';
}

export function errorBox(message) {
  return message ? `<p class="error" role="alert">${esc(message)}</p>` : '';
}

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
