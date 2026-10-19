(() => {
  'use strict';

  if (!/^\/admin(?:\/|$)/.test(window.location.pathname)) return;
  if (document.getElementById('blog-publish-status')) return;

  const messages = {
    idle: '等待发布',
    queued: '等待发布',
    building: '正在发布',
    publishing: '正在发布',
    published: '网站已更新',
    error: '发布失败，文章已保存',
  };

  const bar = document.createElement('aside');
  bar.id = 'blog-publish-status';
  bar.setAttribute('aria-label', '网站发布状态');
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  Object.assign(bar.style, {
    position: 'fixed',
    right: '16px',
    bottom: '88px',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    maxWidth: 'calc(100vw - 32px)',
    padding: '10px 14px',
    border: '1px solid rgba(127,127,127,.25)',
    borderRadius: '12px',
    color: '#eeeeee',
    background: 'rgba(28,28,28,.96)',
    boxShadow: '0 4px 18px rgba(0,0,0,.15)',
    font: '13px/1.5 system-ui, sans-serif',
    boxSizing: 'border-box',
  });

  const text = document.createElement('span');
  text.textContent = messages.idle;
  const log = document.createElement('a');
  log.textContent = '查看详情';
  log.href = '/_publish/log';
  log.target = '_blank';
  log.rel = 'noopener';
  log.hidden = true;
  Object.assign(log.style, {
    color: '#f8c47c',
    textDecoration: 'underline',
    whiteSpace: 'nowrap',
  });
  bar.append(text, log);
  document.body.append(bar);

  let stopped = false;
  let activeController;
  let nextPoll;

  const render = (state) => {
    const nextMessage = messages[state] || messages.idle;
    if (text.textContent !== nextMessage) text.textContent = nextMessage;
    log.hidden = state !== 'error';
  };

  const poll = async () => {
    if (stopped) return;
    activeController = new AbortController();
    const timeout = window.setTimeout(() => activeController.abort(), 8000);
    try {
      const response = await window.fetch('/_publish/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: activeController.signal,
      });
      if (!response.ok) throw new Error('status request failed');
      const data = await response.json();
      render(typeof data.state === 'string' ? data.state : data.status);
    } catch {
      if (!stopped) {
        text.textContent = '发布状态暂时未连接';
        log.hidden = true;
      }
    } finally {
      window.clearTimeout(timeout);
      if (!stopped) nextPoll = window.setTimeout(poll, 3000);
    }
  };

  window.addEventListener('pagehide', () => {
    stopped = true;
    window.clearTimeout(nextPoll);
    activeController?.abort();
  });
  window.addEventListener('pageshow', () => {
    if (!stopped) return;
    stopped = false;
    poll();
  });
  poll();
})();
