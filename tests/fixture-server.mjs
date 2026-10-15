import http from 'node:http';

const html = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>web-control fixture</title></head><body>${body}<script>${script}</script></body></html>`;

export async function createFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');

    if (url.pathname === '/debug-trigger') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('<h1 id="debug-trigger">debug-trigger</h1>', `
        window.__debugTick = 0;
        setInterval(() => { window.__debugTick += 1; }, 25);
      `));
      return;
    }
    if (url.pathname === '/api/value') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'dynamic-ready' }));
      return;
    }
    if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('<h1 id="popup">popup-ready</h1>'));
      return;
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('<button id="login">login</button>', `
        document.querySelector('#login').addEventListener('click', () => {
          document.cookie = 'poc_session=active; Max-Age=86400; Path=/; SameSite=Lax';
          localStorage.setItem('poc_session', 'active');
          location.href = '/account';
        });
      `));
      return;
    }
    if (url.pathname === '/account') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html('<h1>Account</h1><div id="state"></div>', `
        const cookie = document.cookie.includes('poc_session=active') ? 'active' : 'missing';
        const storage = localStorage.getItem('poc_session') || 'missing';
        document.querySelector('#state').textContent = 'cookie=' + cookie + ' storage=' + storage;
      `));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(`
      <h1>web-control fixture</h1>
      <div id="dynamic">loading</div>
      <button id="popup-button">open popup</button>
      <input id="name" value="">
      <div id="echo"></div>
    `, `
      fetch('/api/value').then(r => r.json()).then(data => {
        document.querySelector('#dynamic').textContent = data.value;
      });
      document.querySelector('#popup-button').addEventListener('click', () => window.open('/popup', '_blank'));
      document.querySelector('#name').addEventListener('input', e => {
        document.querySelector('#echo').textContent = e.target.value;
      });
    `));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
