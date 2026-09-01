import Database from 'better-sqlite3';
import path from 'path';
import { Pool, PoolConfig } from 'pg';

let pgPool: Pool | null = null;

export function getPgPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/reserve_db';
  const isRemote = connectionString.includes('supabase.com') || connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
  return {
    connectionString,
    max: parseInt(process.env.PG_POOL_MAX || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: isRemote ? { rejectUnauthorized: false } : undefined,
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
        version INT NOT NULL DEFAULT 1,
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
        decision_status VARCHAR(64) NOT NULL DEFAULT 'allowed',
        payment_status VARCHAR(64) NOT NULL DEFAULT 'requested',
        reason TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        mcc_code VARCHAR(32),
        product_id VARCHAR(255),
        catalog_version VARCHAR(64),
        hash VARCHAR(64) NOT NULL,
        prev_hash VARCHAR(64) NOT NULL,
        sequence_num BIGSERIAL,
        razorpay_order_id VARCHAR(255),
        razorpay_payment_id VARCHAR(255),
        policy_id VARCHAR(255),
        policy_version INT DEFAULT 1,
        session_id VARCHAR(255),
        captured_paise BIGINT DEFAULT 0,
        refunded_paise BIGINT DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        id VARCHAR(255) PRIMARY KEY,
        transaction_id VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default_tenant',
        agent_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        sequence_num BIGSERIAL,
        prev_hash VARCHAR(64) NOT NULL,
        hash VARCHAR(64) NOT NULL,
        policy_id VARCHAR(255),
        policy_version INT DEFAULT 1,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_ledger_tx_seq UNIQUE (transaction_id, sequence_num)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        tenant_id VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255) NOT NULL,
        key VARCHAR(255) NOT NULL,
        request_hash VARCHAR(64) NOT NULL,
        status VARCHAR(64) NOT NULL,
        response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, agent_id, key)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id VARCHAR(255) PRIMARY KEY,
        event_type VARCHAR(128) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      version INTEGER DEFAULT 1,
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
      decisionStatus TEXT DEFAULT 'allowed',
      paymentStatus TEXT DEFAULT 'requested',
      reason TEXT,
      timestamp TEXT NOT NULL,
      mccCode TEXT,
      productId TEXT,
      catalogVersion TEXT,
      hash TEXT,
      prevHash TEXT,
      razorpayOrderId TEXT,
      razorpayPaymentId TEXT,
      agentId TEXT,
      policyId TEXT,
      policyVersion INTEGER DEFAULT 1,
      sessionId TEXT,
      tenantId TEXT,
      capturedPaise INTEGER DEFAULT 0,
      refundedPaise INTEGER DEFAULT 0,
      expiresAt TEXT
    );

    CREATE TABLE IF NOT EXISTS ledger_events (
      id TEXT PRIMARY KEY,
      transactionId TEXT NOT NULL,
      tenantId TEXT NOT NULL DEFAULT 'default_tenant',
      agentId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      sequenceNum INTEGER NOT NULL,
      prevHash TEXT NOT NULL,
      hash TEXT NOT NULL,
      policyId TEXT,
      policyVersion INTEGER DEFAULT 1,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      tenantId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      key TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      status TEXT NOT NULL,
      response TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (tenantId, agentId, key)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      eventId TEXT PRIMARY KEY,
      eventType TEXT NOT NULL,
      payloadHash TEXT NOT NULL,
      receivedAt TEXT NOT NULL,
      processedAt TEXT NOT NULL
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
  try { db.exec('ALTER TABLE policies ADD COLUMN version INTEGER DEFAULT 1;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN allowedMccCodes TEXT;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN sessionId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE policies ADD COLUMN tenantId TEXT;'); } catch {}

  try { db.exec('ALTER TABLE reserve_state ADD COLUMN agentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN totalPaise INTEGER;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN heldPaise INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE reserve_state ADD COLUMN settledPaise INTEGER DEFAULT 0;'); } catch {}

  try { db.exec('ALTER TABLE transactions ADD COLUMN decisionStatus TEXT DEFAULT "allowed";'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN paymentStatus TEXT DEFAULT "requested";'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN mccCode TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN productId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN catalogVersion TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN hash TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN prevHash TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN razorpayOrderId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN razorpayPaymentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN agentId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN policyId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN policyVersion INTEGER DEFAULT 1;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN sessionId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN tenantId TEXT;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN capturedPaise INTEGER DEFAULT 0;'); } catch {}
  try { db.exec('ALTER TABLE transactions ADD COLUMN refundedPaise INTEGER DEFAULT 0;'); } catch {}
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
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tx_seq ON ledger_events(transactionId, sequenceNum);'); } catch {}

  const policyCount = db.prepare("SELECT COUNT(*) as count FROM policies WHERE agentId = 'default_agent' OR id = 1").get() as { count: number };
  if (policyCount.count === 0) {
    db.prepare(`
      INSERT INTO policies (agentId, amountCeiling, category, allowedMerchants, sessionCap, reasonableQuantity, allowedMccCodes, sessionId, tenantId, version)
      VALUES ('default_agent', 50000, 'Electronics', ?, 100000, NULL, NULL, NULL, NULL, 1)
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

