import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

def get_connection():
    """Establish connection to Neon Postgres database."""
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL is not set in the environment variables.")
    return psycopg2.connect(DATABASE_URL)

def init_db():
    """Initialise the postgres tables if they do not exist."""
    sql = """
    CREATE TABLE IF NOT EXISTS triage_records (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      timestamp VARCHAR(30) NOT NULL,
      video_path VARCHAR(255),
      esi_level INTEGER NOT NULL,
      priority_score INTEGER NOT NULL,
      primary_diagnosis VARCHAR(255),
      is_shock BOOLEAN NOT NULL,
      triage_summary TEXT,
      agent_output TEXT,
      heart_rate DOUBLE PRECISION,
      respiration DOUBLE PRECISION,
      hrv DOUBLE PRECISION,
      stress_index DOUBLE PRECISION
    );
    """
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        print("[DB] Neon Postgres database initialised successfully.")
    except Exception as e:
        print(f"[DB] ERROR initialising Neon database: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def save_patient_record(record):
    """Save patient triage record to Neon database."""
    sql = """
    INSERT INTO triage_records (
      id, name, timestamp, video_path, esi_level, priority_score, 
      primary_diagnosis, is_shock, triage_summary, agent_output, 
      heart_rate, respiration, hrv, stress_index
    ) VALUES (
      %(id)s, %(name)s, %(timestamp)s, %(video_path)s, %(esi_level)s, %(priority_score)s, 
      %(primary_diagnosis)s, %(is_shock)s, %(triage_summary)s, %(agent_output)s, 
      %(heart_rate)s, %(respiration)s, %(hrv)s, %(stress_index)s
    ) ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      timestamp = EXCLUDED.timestamp,
      video_path = EXCLUDED.video_path,
      esi_level = EXCLUDED.esi_level,
      priority_score = EXCLUDED.priority_score,
      primary_diagnosis = EXCLUDED.primary_diagnosis,
      is_shock = EXCLUDED.is_shock,
      triage_summary = EXCLUDED.triage_summary,
      agent_output = EXCLUDED.agent_output,
      heart_rate = EXCLUDED.heart_rate,
      respiration = EXCLUDED.respiration,
      hrv = EXCLUDED.hrv,
      stress_index = EXCLUDED.stress_index;
    """
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute(sql, record)
        conn.commit()
        print(f"[DB] Saved patient record {record.get('id')} ({record.get('name')}) to Neon.")
        return True
    except Exception as e:
        print(f"[DB] ERROR saving record {record.get('id')}: {e}")
        if conn:
            conn.rollback()
        return False
    finally:
        if conn:
            conn.close()

def get_all_patients():
    """Retrieve all triage records ordered by urgency (ESI level asc, then priority_score desc)."""
    sql = """
    SELECT * FROM triage_records 
    ORDER BY esi_level ASC, priority_score DESC, timestamp DESC;
    """
    conn = None
    try:
        conn = get_connection()
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            rows = cur.fetchall()
            return [dict(row) for row in rows]
    except Exception as e:
        print(f"[DB] ERROR fetching patients: {e}")
        return []
    finally:
        if conn:
            conn.close()

def clear_all_patients():
    """Delete all triage records from Neon database."""
    sql = "TRUNCATE TABLE triage_records;"
    conn = None
    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        print("[DB] Flushed/Truncated all records in Neon Postgres.")
        return True
    except Exception as e:
        print(f"[DB] TRUNCATE failed: {e}. Trying DELETE...")
        try:
            if conn:
                conn.rollback()
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM triage_records;")
                conn.commit()
                print("[DB] Deleted all records in Neon Postgres.")
                return True
        except Exception as delete_err:
            print(f"[DB] DELETE failed as well: {delete_err}")
            if conn:
                conn.rollback()
        return False
    finally:
        if conn:
            conn.close()
