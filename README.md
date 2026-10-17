# Votación en directo 🗳️

Un tablero de votación en tiempo real con WebSockets, pensado para hacer una demo en directo de [Render](https://render.com). El público vota desde el móvil escaneando un QR y los resultados se actualizan al instante en el proyector.

- **Node.js + Express + `ws`**: sin Socket.IO, para que el protocolo se entienda de un vistazo.
- **PostgreSQL (`pg`)**: los votos sobreviven a un redeploy.
- **HTML, CSS y JS vanilla**: sin frameworks ni build step.

| Ruta | Para quién |
|---|---|
| `/` | El público: vota desde el móvil y ve los resultados en vivo |
| `/screen` | El proyector: barras animadas, QR, votos y personas conectadas (doble clic = pantalla completa) |
| `/admin` | Tú: crear, activar, cerrar y reiniciar encuestas (pide el `ADMIN_TOKEN`) |
| `/healthz` | Render: 200 si el servidor y la base de datos responden |

## Cómo funciona

```
 móvil ──POST /api/vote──▶ Express ──INSERT──▶ Postgres
                             │
                             └─ broadcast() ──WebSocket──▶ todos los clientes
```

1. El móvil genera un id anónimo (`localStorage`) y vota con un `POST`.
2. Postgres impide los votos duplicados con la clave primaria `(poll_id, voter_id)`.
3. El servidor envía el estado completo (`{ poll, counts, total, online, myVote }`) a todos los sockets. Si llegan muchos votos a la vez, los agrupa en un único envío cada 100 ms.
4. **Heartbeat**: cada 25 s el servidor hace `ping` y desconecta a quien no respondió con `pong`. Así los proxies no cortan las conexiones inactivas.
5. **Reconexión**: si el socket se cierra (por ejemplo, durante un redeploy), el cliente reintenta con backoff exponencial (1 s, 2 s, 4 s… hasta 10 s, con algo de aleatoriedad).

Archivos:

```
server.js        Express, API, WebSockets, heartbeat y apagado ordenado
db.js            Conexión a Postgres, creación de tablas y consultas
public/live.js   Cliente WebSocket con reconexión y pintado de barras
public/*.html    Las tres vistas
public/style.css Estilos (el color de las barras es la variable --bar)
render.yaml      Blueprint de Render
```

## Arrancar en local

Requisitos: Node.js 20.6 o superior y Docker.

```bash
docker compose up -d
```

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
npm run dev
```

Abre:

- http://localhost:3000/admin: introduce el token de `.env` (`cambia-esto`), crea una encuesta y actívala.
- http://localhost:3000/screen: la vista del proyector.
- http://localhost:3000: vota. Para simular a varias personas, abre ventanas de incógnito, porque cada una tiene su propio `localStorage`.

Las tablas se crean solas al arrancar. `npm run dev` reinicia el servidor al guardar cambios, lo que sirve para ver la reconexión de los clientes.

## Desplegar en Render

1. **Sube el código a GitHub** (o GitLab o Bitbucket):
   ```bash
   git init && git add . && git commit -m "Votación en directo"
   ```
   Crea un repositorio vacío en GitHub y sigue sus instrucciones para hacer `git remote add origin …` y `git push -u origin main`.
2. En el [Dashboard de Render](https://dashboard.render.com) pulsa **New → Blueprint**.
3. **Conecta el repositorio**. Render detecta `render.yaml` y muestra lo que va a crear:
   - el Web Service `live-poll` (Node, plan free, health check en `/healthz`, auto-deploy en cada commit),
   - la base de datos `live-poll-db` (Postgres, plan free),
   - `DATABASE_URL`, enlazada a la base de datos, y `ADMIN_TOKEN`, generado aleatoriamente.
4. Pulsa **Deploy Blueprint** y espera a que el servicio aparezca como *Live*.
5. Copia el `ADMIN_TOKEN` desde **live-poll → Environment** y entra en `https://<tu-servicio>.onrender.com/admin`.

> ⚠️ **Plan gratuito**
> - El servicio **se suspende tras 15 minutos sin tráfico** y tarda alrededor de un minuto en despertar. **Abre la URL (por ejemplo `/screen`) unos minutos antes de empezar la demo.** Mientras el proyector esté conectado, los mensajes del WebSocket lo mantienen despierto.
> - La base de datos gratuita **caduca a los 30 días**. Créala cerca de la fecha de la charla.

### Por qué una sola instancia

Las conexiones WebSocket viven en la memoria del proceso. Con varias instancias, un voto recibido en la instancia A solo se difundiría a los clientes conectados a A. Para escalar haría falta un canal compartido, como Redis pub/sub o `LISTEN/NOTIFY` de Postgres, para que todas las instancias se enteren de cada cambio (está comentado en `server.js`).

## Guion de demo (unos 10 minutos)

**Antes de empezar (5 min antes):** abre `/screen` en el proyector para despertar el servicio. Ten en el portátil una pestaña con `/admin` (con una encuesta ya creada), otra con el Dashboard de Render y otra con el editor.

| Min | Qué haces | Qué cuentas |
|---|---|---|
| 0–2 | Enseña el repo: `render.yaml`, `server.js` y `live.js`. | "Infraestructura como código: un archivo describe el servicio web, la base de datos y las variables. Render crea todo desde el repo." |
| 2–3 | En el Dashboard, enseña el Blueprint ya desplegado: servicio, base de datos y el enlace `DATABASE_URL`. Si tienes tiempo, despliega desde cero en directo (New → Blueprint), aunque tarda unos minutos. | "No he configurado ningún servidor. HTTPS, dominio y health check vienen incluidos." |
| 3–5 | En `/admin`, activa la encuesta. Pon `/screen` a pantalla completa (doble clic) y pide al público que escanee el QR y vote. | Señala el contador de conectados y las barras moviéndose. "Cada voto es un POST, y el servidor lo difunde por WebSocket a todos." |
| 5–7 | **Cambio en directo:** en `public/style.css`, cambia `--bar: #7c5cff;` por `--bar: #00c48c;`. Después ejecuta `git commit -am "Barras verdes" && git push`. En el Dashboard, abre **Events**: el deploy arranca solo. | "Auto-deploy: cada push a `main` construye y despliega." Mientras se construye, la app sigue funcionando. |
| 7–8 | Cuando el nuevo deploy pasa a *Live*, el servidor antiguo recibe `SIGTERM` y cierra los sockets. En el proyector, el indicador pasa a "reconectando…" y vuelve a "● en directo" con **las barras verdes y los votos intactos**. | "Los votos están en Postgres, no en memoria. Los clientes se reconectan solos con backoff exponencial." |
| 8–9 | Enseña **Logs** (aparecen `SIGTERM recibido…` y `Escuchando en…`) y **Environment** (`DATABASE_URL` enlazada y `ADMIN_TOKEN` generado; no lo muestres en el proyector). | "Las credenciales no están en el código: llegan como variables de entorno." |
| 9–10 | **Rollback:** en **Deploys**, busca el deploy anterior y pulsa **Rollback → Rollback to this deploy**. Las barras vuelven al color original sin tocar Git. | "Si un deploy sale mal, se vuelve atrás en segundos." Avisa de que el rollback desde el Dashboard **desactiva el auto-deploy**: reactívalo después en **Settings**. |

Ideas extra si sobra tiempo: cierra la encuesta desde `/admin` (los móviles ven "Votación cerrada"), reinicia los votos o pide al público que intente votar dos veces (verán el 409).

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP. Render la define automáticamente. |
| `DATABASE_URL` | Cadena de conexión de Postgres. |
| `ADMIN_TOKEN` | Token para `/admin`. Si no está definido, la API de admin rechaza todas las peticiones. |
