import { getReadingProgress } from '../lib/reading-progress';

type Section = { target: HTMLElement; link: HTMLAnchorElement; item: HTMLLIElement };
const instances = new WeakMap<HTMLElement, () => void>();

export const initReadingRail = () => {
  const root = document.querySelector<HTMLElement>('[data-reading-rail]');
  const prose = document.querySelector<HTMLElement>('[data-reading-body]');
  if (!root || !prose) return;
  instances.get(root)?.();
  const panel = root.querySelector<HTMLDetailsElement>('details');
  const summary = root.querySelector<HTMLElement>('summary');
  const list = root.querySelector<HTMLOListElement>('[data-reading-list]');
  const total = root.querySelector<HTMLElement>('[data-reading-total]');
  if (!panel || !summary || !list || !total) return;

  const abort = new AbortController();
  const { signal } = abort;
  let sections: Section[] = [];
  let offsets: number[] = [];
  let end = 0;
  let dirty = true;
  let frame = 0;
  let activeIndex = -1;
  let placement = '';

  const uniqueId = (element: HTMLElement, preferred: string) => {
    if (element.id) return element.id;
    let id = preferred;
    let suffix = 1;
    while (document.getElementById(id)) id = `${preferred}-${suffix++}`;
    element.id = id;
    return id;
  };

  const showLabel = (link: HTMLElement) => {
    const row = link.getBoundingClientRect();
    root.style.setProperty('--reading-label-top', `${row.top + row.height / 2 - root.getBoundingClientRect().top}px`);
  };

  const buildSections = () => {
    const headings = Array.from(prose.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
      .filter((heading) => heading.textContent?.trim() && heading.getClientRects().length > 0);
    list.replaceChildren();
    sections = [];
    activeIndex = -1;
    root.hidden = headings.length === 0;
    if (root.hidden) return;
    const minimumDepth = Math.min(...headings.map((heading) => Number(heading.tagName.slice(1))));
    const targets = [{ target: prose, title: '开篇', depth: 0 }, ...headings.map((heading, index) => ({
      target: heading,
      title: heading.textContent!.replace(/\s+/g, ' ').trim(),
      depth: Number(heading.tagName.slice(1)) - minimumDepth,
      index
    }))];
    targets.forEach(({ target, title, depth }, index) => {
      const id = uniqueId(target, index === 0 ? 'article-start' : `reading-heading-${index}`);
      const item = document.createElement('li');
      item.className = 'reading-rail__item';
      item.dataset.depth = String(depth);
      const link = document.createElement('a');
      link.className = 'reading-rail__link';
      link.href = `#${encodeURIComponent(id)}`;
      link.setAttribute('aria-label', `${title}${index > 0 ? `（${target.tagName}）` : ''}`);
      const mark = document.createElement('span');
      mark.className = 'reading-rail__mark';
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'reading-rail__label';
      label.textContent = title;
      link.append(mark, label);
      item.append(link);
      list.append(item);
      link.addEventListener('pointerenter', () => showLabel(link), { signal });
      link.addEventListener('focus', () => showLabel(link), { signal });
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        history.pushState(null, '', link.hash);
        if (placement === 'inline') panel.open = false;
        if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        queueMeasure();
      }, { signal });
      sections.push({ target, link, item });
    });
    dirty = true;
  };

  const measure = () => {
    let rect = prose.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const gutter = viewport - rect.right;
    const nextPlacement = viewport >= 1100 && gutter >= 108 ? 'rail' : 'inline';
    root.dataset.placement = nextPlacement;
    if (placement !== nextPlacement) {
      placement = nextPlacement;
      panel.open = placement === 'rail';
      summary.tabIndex = placement === 'rail' ? -1 : 0;
    }
    if (placement === 'rail') {
      root.style.left = `${rect.right + 20}px`;
      root.style.width = `${Math.min(140, gutter - 44)}px`;
    } else {
      root.style.removeProperty('left');
      root.style.removeProperty('width');
    }
    rect = prose.getBoundingClientRect();
    offsets = sections.map(({ target }) => target.getBoundingClientRect().top + window.scrollY);
    end = rect.bottom + window.scrollY;
    dirty = false;
  };

  const update = () => {
    frame = 0;
    if (root.hidden) return;
    if (dirty) measure();
    const cursor = window.scrollY + Math.min(120, window.innerHeight * 0.18);
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 3;
    const progress = getReadingProgress(offsets, end, cursor, atBottom);
    total.textContent = `${Math.round(progress.totalProgress * 100)}%`;
    total.setAttribute('aria-label', `阅读进度 ${Math.round(progress.totalProgress * 100)}%`);
    const changed = activeIndex !== progress.activeIndex;
    activeIndex = progress.activeIndex;
    sections.forEach(({ link, item }, index) => {
      item.dataset.state = index === activeIndex ? 'current' : index < activeIndex ? 'read' : 'unread';
      if (index === activeIndex) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
      link.style.setProperty('--section-progress', String(index < activeIndex ? 1 : index === activeIndex ? progress.sectionProgress : 0));
    });
    if (changed && placement === 'rail' && !root.matches(':hover,:focus-within')) {
      const item = sections[activeIndex]?.item;
      if (item) {
        const row = item.getBoundingClientRect();
        const area = list.getBoundingClientRect();
        if (row.top < area.top || row.bottom > area.bottom) list.scrollTop += row.top - area.top - area.height / 2 + row.height / 2;
      }
    }
  };

  function queueUpdate() { if (!frame) frame = requestAnimationFrame(update); }
  function queueMeasure() { dirty = true; queueUpdate(); }

  buildSections();
  queueMeasure();
  window.addEventListener('scroll', queueUpdate, { passive: true, signal });
  window.addEventListener('resize', queueMeasure, { passive: true, signal });
  window.addEventListener('astro-whono:reading-mode-change', queueMeasure, { signal });
  summary.addEventListener('click', (event) => { if (placement === 'rail') event.preventDefault(); }, { signal });
  panel.addEventListener('toggle', queueMeasure, { signal });
  prose.addEventListener('toggle', () => { buildSections(); queueMeasure(); }, { capture: true, signal });
  const observer = new ResizeObserver(queueMeasure);
  observer.observe(prose);
  void document.fonts.ready.then(() => { if (!signal.aborted) queueMeasure(); });
  const cleanup = () => {
    abort.abort();
    observer.disconnect();
    cancelAnimationFrame(frame);
    instances.delete(root);
  };
  window.addEventListener('pagehide', (event) => { if (!event.persisted) cleanup(); }, { signal });
  instances.set(root, cleanup);
};
