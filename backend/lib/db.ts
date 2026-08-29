import Database from 'better-sqlite3';
import path from 'path';
import { Pool, PoolConfig } from 'pg';

let pgPool: Pool | null = null;

export function getPgPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/reserve_db';
  return {
    connectionString,
    max: parseInt(process.env.PG_POOL_MAX || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

export function getPgPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool(getPgPoolConfig());
    pgPool.on('error', (err) => {
      console.error('[Postgres Pool Error]', err);
    });
  }
  return pgPool;
}

export async function closePgPool(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}

export async function initPostgresDatabase(pool?: Pool): Promise<void> {
  const p = pool || getPgPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS policies (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) UNIQUE NOT NULL,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default_tenant',
        amount_ceiling BIGINT,
        category VARCHAR(255),
        allowed_merchants JSONB NOT NULL DEFAULT '[]'::jsonb,
        session_cap BIGINT,
        reasonable_quantity NUMERIC,
        allowed_mcc_codes JSONB,
        session_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reserve_state (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) UNIQUE NOT NULL,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default_tenant',
        total_paise BIGINT NOT NULL DEFAULT 200000,
        held_paise BIGINT NOT NULL DEFAULT 0,
        settled_paise BIGINT NOT NULL DEFAULT 0,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_reserve_non_negative CHECK (held_paise >= 0 AND settled_paise >= 0 AND total_paise >= 0)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(255) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default_tenant',
        merchant VARCHAR(255) NOT NULL,
        amount BIGINT NOT NULL,
        category VARCHAR(255) NOT NULL,
        quantity NUMERIC,
        status VARCHAR(64) NOT NULL,
        reason TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        mcc_code VARCHAR(32),
        hash VARCHAR(64) NOT NULL,
        prev_hash VARCHAR(64) NOT NULL,
        sequence_num BIGSERIAL,
        razorpay_order_id VARCHAR(255),
        razorpay_payment_id VARCHAR(255),
        policy_id VARCHAR(255),
        session_id VARCHAR(255),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS security_audit_logs (
        id VARCHAR(255) PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        role VARCHAR(64),
        identity VARCHAR(255),
        endpoint VARCHAR(255) NOT NULL,
        method VARCHAR(16) NOT NULL,
        details TEXT NOT NULL,
        ip VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// SQLite Store Initialization
// ---------------------------------------------------------------------------

const getDbPath = () => {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    const poolId = process.env.VITEST_POOL_ID || '0';
    return path.join(process.cwd(), `reserve_test_${poolId}.db`);
  }
  return path.join(process.cwd(), 'reserve.db');
};

const dbPath = getDbPath();
const db = new Database(dbPath);

db.pragma('busy_timeout = 5000');

try {
  db.pragma('journal_mode = WAL');
} catch {}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT UNIQUE,
      amountCeiling INTEGER,
      category TEXT,
      allowedMerchants TEXT NOT NULL,
      sessionCap INTEGER,
      reasonableQuantity REAL,
      allowedMccCodes TEXT,
      sessionId TEXT,
      tenantId TEXT
    );

    CREATE TABLE IF NOT EXISTS reserve_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT UNIQUE,
      totalPaise INTEGER NOT NULL DEFAULT 200000,
      heldPaise INTEGER NOT NULL DEFAULT 0,
      settledPaise INTEGER NOT NULL DEFAULT 0,
      total INTEGER,
      remaining INTEGER
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      merchant TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      quantity INTEGER,
      status TEXT NOT NULL,
      reason TEXT,
      timestamp TEXT NOT NULL,
      mccCode TEXT,
      hash TEXT,
      prevHash TEXT,
      razorpayOrderId TEXT,
      razorpayPaymentId TEXT,
      agentId TEXT,
      policyId TEXT,
      sessionId TEXT,
      tenantId TEXT,
      expiresAt TEXT
    );

    CREATE TABLE IF NOT EXISTS security_audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      eventType TEXT NOT NULL,
      role TEXT,
      identity TEXT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      details TEXT NOT NULL,
      ip TEXT
    );
  `);

  try { db.exec('ALTER TABLE policies ADD COLUMN agentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN allowedMccCodes TEXT;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN sessionId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN tenantId TEXT;'); } catch {}

  try { db.exec('ALTER TABLE reserve_state ADD COLUMN agentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN totalPaise INTEGER;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN heldPaise INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN settledPaise INTEGER DEFAULT 0;'); } catch {}

  try { db.exec('ALTER TABLE transactions ADD COLUMN mccCode TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN hash TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN prevHash TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN razorpayOrderId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN razorpayPaymentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN agentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN policyId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN sessionId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN tenantId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN expiresAt TEXT;'); } catch {}

  try { db.exec("UPDATE policies SET agentId = 'default_agent' WHERE agentId IS NULL;"); } catch {}
  try { db.exec("UPDATE reserve_state SET agentId = 'default_agent' WHERE agentId IS NULL;"); } catch {}

  try {
    db.exec(`
      UPDATE reserve_state
      SET totalPaise = COALESCE(totalPaise, CASE WHEN total IS NOT NULL THEN CAST(ROUND(total * 100) AS INTEGER) ELSE 200000 END),
          heldPaise = COALESCE(heldPaise, 0),
          settledPaise = COALESCE(settledPaise, 0)
      WHERE totalPaise IS NULL;
    `);
  } catch {}

  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_agentId ON policies(agentId);'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_state_agentId ON reserve_state(agentId);'); } catch {}

  const policyCount = db.prepare("SELECT COUNT(*) as count FROM policies WHERE agentId = 'default_agent' OR id = 1").get() as { count: number };
  if (policyCount.count === 0) {
    db.prepare(`
      INSERT INTO policies (agentId, amountCeiling, category, allowedMerchants, sessionCap, reasonableQuantity, allowedMccCodes, sessionId, tenantId)
      VALUES ('default_agent', 50000, 'Electronics', ?, 100000, NULL, NULL, NULL, NULL)
    `).run(JSON.stringify(['Amazon', 'BestBuy']));
  }

  const reserveStateCount = db.prepare("SELECT COUNT(*) as count FROM reserve_state WHERE agentId = 'default_agent' OR id = 1").get() as { count: number };
  if (reserveStateCount.count === 0) {
    db.prepare(`
      INSERT INTO reserve_state (agentId, totalPaise, heldPaise, settledPaise, total, remaining)
      VALUES ('default_agent', 200000, 0, 0, 2000, 2000)
    `).run();
  }
}

initDatabase();

export default db;
