const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./db');

const app = express();
app.use(express.json());
// /screen -> screen.html, /admin -> admin.html
app.use(express.static('public', { extensions: ['html'] }));

// ---------- HTTP ----------

app.get('/healthz', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.send('ok');
  } catch {
    res.status(503).send('database unavailable');
  }
});

app.post('/api/vote', async (req, res) => {
  const { pollId, voterId, option } = req.body;
  if (!voterId || !Number.isInteger(option)) return res.status(400).json({ error: 'Voto no válido' });
  const ok = await db.vote(pollId, String(voterId).slice(0, 64), option);
  if (!ok) return res.status(409).json({ error: 'Ya has votado o la encuesta está cerrada' });
  res.json({ ok: true });
  broadcast();
});

// Las rutas de admin exigen la cabecera x-admin-token = ADMIN_TOKEN
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.get('x-admin-token') === token) return next();
  res.status(401).json({ error: 'Token incorrecto' });
}

app.get('/api/admin/polls', requireAdmin, async (req, res) => {
  res.json(await db.listPolls());
});

app.post('/api/admin/polls', requireAdmin, async (req, res) => {
  const question = String(req.body.question || '').trim();
  const options = (req.body.options || []).map(o => String(o).trim()).filter(Boolean);
  if (!question || options.length < 2 || options.length > 6) {
    return res.status(400).json({ error: 'Hace falta una pregunta y entre 2 y 6 opciones' });
  }
  await db.createPoll(question, options);
  res.json({ ok: true });
});

const actions = { activate: db.activate, close: db.close, reset: db.reset };
app.post('/api/admin/polls/:id/:action', requireAdmin, async (req, res) => {
  const action = actions[req.params.action];
  if (!action) return res.status(404).json({ error: 'Acción desconocida' });
  await action(Number(req.params.id));
  res.json({ ok: true });
  broadcast();
});

// ---------- WebSockets ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// NOTA: todo el estado de las conexiones vive en la memoria de este proceso.
// Con una sola instancia es suficiente. Si escaláramos a varias instancias,
// cada una solo conocería a sus propios clientes: un voto recibido en la
// instancia A no llegaría a los clientes conectados a la B. Haría falta un
// canal pub/sub compartido (Redis, o LISTEN/NOTIFY de Postgres) para que todas
// las instancias se enteren de cada cambio y lo difundan a sus clientes.

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  ws.voterId = params.get('voter');
  ws.isAdmin = params.get('role') === 'admin';
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', broadcast);
  broadcast();
});

// Heartbeat: los proxies cortan conexiones inactivas, así que cada 25 s
// enviamos un ping. Si un cliente no respondió al anterior, lo damos por muerto.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// Envía el estado completo a todos los clientes. Agrupa los cambios que
// llegan en ráfaga (100 votos en un segundo) en un único envío cada 100 ms.
let scheduled = null;
function broadcast() {
  if (scheduled) return;
  scheduled = setTimeout(async () => {
    scheduled = null;
    try {
      const poll = await db.currentPoll();
      const votes = poll ? await db.votesFor(poll.id) : new Map();
      const counts = poll ? poll.options.map(() => 0) : [];
      for (const option of votes.values()) counts[option]++;
      const online = [...wss.clients].filter(ws => !ws.isAdmin).length;
      const state = { type: 'state', poll, counts, total: votes.size, online };

      for (const ws of wss.clients) {
        if (ws.readyState !== ws.OPEN) continue;
        // Cada votante recibe además qué opción votó (o null)
        ws.send(JSON.stringify({ ...state, myVote: votes.get(ws.voterId) ?? null }));
      }
    } catch (err) {
      console.error('broadcast failed:', err.message);
    }
  }, 100);
}

// ---------- Arranque y parada ----------

const port = process.env.PORT || 3000;
db.init().then(() => {
  server.listen(port, () => console.log(`Escuchando en http://localhost:${port}`));
});

// En cada redeploy, Render envía SIGTERM a la instancia antigua.
// Cerramos los sockets con el código 1012 ("service restart") y los clientes
// se reconectarán solos a la instancia nueva.
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando conexiones…`);
  for (const ws of wss.clients) ws.close(1012, 'Reiniciando');
  server.close(() => db.pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref(); // por si algo se queda colgado
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
