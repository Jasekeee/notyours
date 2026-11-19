// Terminal replay: reveals [data-term] lines once, in order. A replay button restarts it.
// Static (everything shown) under prefers-reduced-motion or with ?static in the URL.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || /[?&]static\b/.test(location.search);
  for (const term of document.querySelectorAll('[data-term]')) {
    const scope = term.closest('[data-term-scope]') || term;
    const lines = [...term.querySelectorAll('.l')];
    const floats = [...scope.querySelectorAll('[data-at]')];
    const typed = lines.filter((l) => l.dataset.type !== undefined).map((l) => {
      const node = l.querySelector('[data-typed]');
      return { l, node, text: node ? node.textContent : '' };
    });
    const btn = scope.querySelector('[data-replay]');
    let timers = [];
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const showAll = () => {
      lines.forEach((l) => l.classList.add('on'));
      floats.forEach((f) => f.classList.add('on'));
      typed.forEach((t) => { if (t.node) t.node.textContent = t.text; });
      term.classList.remove('typing');
      scope.classList.add('done');
    };
    const play = () => {
      clear();
      scope.classList.remove('done');
      lines.forEach((l) => l.classList.remove('on'));
      floats.forEach((f) => f.classList.remove('on'));
      typed.forEach((t) => { if (t.node) t.node.textContent = ''; });
      let at = 300;
      lines.forEach((l, i) => {
        at += Number(l.dataset.delay || 140);
        const t = typed.find((x) => x.l === l);
        timers.push(setTimeout(() => {
          l.classList.add('on');
          floats.filter((f) => Number(f.dataset.at) === i).forEach((f) => f.classList.add('on'));
        }, at));
        if (t && t.node) {
          for (let c = 1; c <= t.text.length; c++) timers.push(setTimeout(() => { t.node.textContent = t.text.slice(0, c); }, at + c * 28));
          at += t.text.length * 28;
        }
      });
      timers.push(setTimeout(() => scope.classList.add('done'), at + 200));
    };
    if (btn) btn.addEventListener('click', () => (reduce ? showAll() : play()));
    if (reduce) { showAll(); continue; }
    term.classList.add('armed');
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
    }, { threshold: 0.3 });
    io.observe(term);
  }

  // copy buttons
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const src = document.getElementById(b.dataset.copy);
      const text = src ? src.textContent.trim() : b.dataset.copy;
      try { await navigator.clipboard.writeText(text); } catch { return; }
      b.setAttribute('data-copied', '');
      const label = b.getAttribute('aria-label');
      b.setAttribute('aria-label', 'Copied');
      setTimeout(() => { b.removeAttribute('data-copied'); b.setAttribute('aria-label', label); }, 1600);
    });
  }

  // tabs (WAI-ARIA tabs pattern: click, arrow keys, Home/End)
  for (const box of document.querySelectorAll('[data-tabs]')) {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    const select = (t) => {
      for (const x of tabs) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
      }
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (n === undefined) return;
        e.preventDefault();
        const next = tabs[(n + tabs.length) % tabs.length];
        select(next); next.focus();
      });
    });
  }
})();
