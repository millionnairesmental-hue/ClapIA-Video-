#!/usr/bin/env node
// simple health-check test used by `npm test` in this repo
import http from 'http';

const opts = { method: 'GET', host: 'localhost', port: 3000, path: '/api/health', timeout: 2000 };

const req = http.request(opts, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try{
      const json = JSON.parse(data);
      if (json && json.ok) { console.log('OK'); process.exit(0); }
      console.error('Unexpected response', data); process.exit(2);
    }catch(e){ console.error('Invalid JSON', data); process.exit(2); }
  });
});
req.on('error', (e) => { console.error('Error connecting to server:', e.message); process.exit(2); });
req.end();
