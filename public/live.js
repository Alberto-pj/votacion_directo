// Conexión WebSocket con reconexión automática y backoff exponencial.
// Durante un redeploy el servidor se cae unos segundos: los clientes
// reintentan a 1 s, 2 s, 4 s… (máximo 10 s) hasta que vuelve.
function connectLive(query, onState) {
  const status = document.getElementById('status');
  let delay = 1000;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?${new URLSearchParams(query)}`);

    ws.onopen = () => {
      delay = 1000;
      status.textContent = '● en directo';
      status.className = 'status online';
    };
    ws.onmessage = e => onState(JSON.parse(e.data));
    ws.onclose = () => {
      status.textContent = `reconectando en ${Math.round(delay / 1000)} s…`;
      status.className = 'status offline';
      // El jitter evita que cientos de móviles reconecten en el mismo milisegundo
      setTimeout(open, delay + Math.random() * 500);
      delay = Math.min(delay * 2, 10_000);
    };
  }
  open();
}

// Pinta (o actualiza) las barras. Reutiliza los elementos existentes para
// que la transición CSS de la anchura se anime en cada voto.
function renderBars(el, poll, counts, myVote = null) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (el.dataset.poll !== String(poll.id)) {
    el.dataset.poll = poll.id;
    el.innerHTML = poll.options.map(() => `
      <div class="bar">
        <div class="label"><span class="name"></span><span class="count"></span></div>
        <div class="track"><div class="fill"></div></div>
      </div>`).join('');
  }
  poll.options.forEach((option, i) => {
    const bar = el.children[i];
    const pct = total ? Math.round((counts[i] * 100) / total) : 0;
    bar.querySelector('.name').textContent = option; // textContent: nada de inyectar HTML
    bar.querySelector('.count').textContent = `${counts[i]} · ${pct}%`;
    bar.querySelector('.fill').style.width = `${pct}%`;
    bar.classList.toggle('mine', i === myVote);
  });
}
