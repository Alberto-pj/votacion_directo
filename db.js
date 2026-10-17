const { Pool } = require('pg');

// En Render usamos la URL interna de la base de datos, que no necesita SSL.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Crea las tablas si no existen (sin herramienta de migraciones).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polls (
      id         SERIAL PRIMARY KEY,
      question   TEXT NOT NULL,
      options    TEXT[] NOT NULL CHECK (array_length(options, 1) BETWEEN 2 AND 6),
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Solo puede haber una encuesta activa a la vez
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_poll ON polls ((status)) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS votes (
      poll_id    INT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      voter_id   TEXT NOT NULL,
      option_idx SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (poll_id, voter_id) -- un voto por persona y encuesta
    );
  `);
}

// La encuesta que se muestra: la activa o, si no hay, la última cerrada.
async function currentPoll() {
  const { rows } = await pool.query(`
    SELECT id, question, options, status FROM polls
    WHERE status <> 'draft'
    ORDER BY status = 'active' DESC, id DESC
    LIMIT 1`);
  return rows[0] || null;
}

// Todos los votos de una encuesta: { voterId: optionIdx }
async function votesFor(pollId) {
  const { rows } = await pool.query(
    'SELECT voter_id, option_idx FROM votes WHERE poll_id = $1', [pollId]);
  return new Map(rows.map(r => [r.voter_id, r.option_idx]));
}

// Devuelve true si el voto se ha guardado. Falla si ya votó, la encuesta
// no está activa o la opción no existe.
async function vote(pollId, voterId, optionIdx) {
  const { rowCount } = await pool.query(`
    INSERT INTO votes (poll_id, voter_id, option_idx)
    SELECT id, $2, $3::smallint FROM polls
    WHERE id = $1 AND status = 'active' AND $3::smallint BETWEEN 0 AND array_length(options, 1) - 1
    ON CONFLICT DO NOTHING`, [pollId, voterId, optionIdx]);
  return rowCount === 1;
}

// --- Admin ---

async function listPolls() {
  const { rows } = await pool.query(`
    SELECT p.id, p.question, p.options, p.status,
           (SELECT count(*)::int FROM votes v WHERE v.poll_id = p.id) AS votes
    FROM polls p ORDER BY p.id DESC`);
  return rows;
}

function createPoll(question, options) {
  return pool.query('INSERT INTO polls (question, options) VALUES ($1, $2)', [question, options]);
}

// Activar una encuesta cierra la que estuviera activa (en una transacción).
async function activate(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE polls SET status = 'closed' WHERE status = 'active'`);
    await client.query(`UPDATE polls SET status = 'active' WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const close = id => pool.query(`UPDATE polls SET status = 'closed' WHERE id = $1`, [id]);
const reset = id => pool.query('DELETE FROM votes WHERE poll_id = $1', [id]);

module.exports = { pool, init, currentPoll, votesFor, vote, listPolls, createPoll, activate, close, reset };
