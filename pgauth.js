/*****************************************************************
 * Custom Baileys auth‑state backed by PostgreSQL
 * Auto‑creates `auth_state` table if it doesn’t exist
 *****************************************************************/

import 'dotenv/config'
import pkg from 'pg'
const { Pool } = pkg

/* ─────── Connect pool ───────────────────────────────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false } // Render cloud PG
    : false
})

/* ─────── Ensure table exists ───────────────────────────────── */
await pool.query(`
  CREATE TABLE IF NOT EXISTS auth_state (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  );
`)

/* ─────── Main factory fn used by Baileys ───────────────────── */
export async function usePostgresAuthState () {
  /* load everything into memory once ------------------------------------- */
  const credsRow = await pool.query(`SELECT value FROM auth_state WHERE key = 'creds'`)
  const creds = credsRow.rows[0]?.value || {}
  const keyRows = await pool.query(`SELECT * FROM auth_state WHERE key != 'creds'`)
  const keysInMem = Object.fromEntries(keyRows.rows.map(r => [r.key, r.value]))

  /* helpers required by Baileys ----------------------------------------- */
  const saveCreds = async () => {
    // save creds
    await pool.query(
      `INSERT INTO auth_state (key, value)
       VALUES ('creds', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [creds]
    )
    // save keys
    for (const [k, v] of Object.entries(keysInMem)) {
      await pool.query(
        `INSERT INTO auth_state (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, v]
      )
    }
  }

  const state = {
    creds,
    keys: {
      /** get key(s) by type & ids */
      get: (type, ids) =>
        ids.reduce((dict, id) => {
          const value = keysInMem[`${type}-${id}`]
          if (value) dict[id] = value
          return dict
        }, {}),
      /** set key(s) by type */
      set: data => {
        for (const [type, obj] of Object.entries(data))
          for (const [id, val] of Object.entries(obj))
            keysInMem[`${type}-${id}`] = val
      }
    }
  }

  return { state, saveCreds }
}
