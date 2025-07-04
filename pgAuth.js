// pgAuth.js — Custom PostgreSQL-based auth adapter for Baileys
import pkg from 'pg'
const { Pool } = pkg

export async function usePostgresAuthState ({
  id = 'default',
  tableName = 'auth_state'
} = {}) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // ⬅️ REQUIRED on Render
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      data JSONB
    )
  `)

  const readData = async () => {
    const res = await pool.query(`SELECT data FROM ${tableName} WHERE id = $1`, [id])
    return res.rows[0]?.data || {}
  }

  const writeData = async data => {
    await pool.query(`
      INSERT INTO ${tableName} (id, data)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET data = $2
    `, [id, data])
  }

  const state = await readData()

  return {
    state,
    saveCreds: async () => {
      const updatedState = await readData()
      await writeData(updatedState)
    }
  }
}
