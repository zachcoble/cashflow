"""SQLite layer for CashFlow. One file DB, schema created on import."""
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "cashflow.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenarios (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS income_streams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    annual_gross REAL NOT NULL,
    slider_min   REAL NOT NULL DEFAULT 0,
    slider_max   REAL NOT NULL DEFAULT 200000,
    tax_rate     REAL,           -- NULL = use global default_tax_rate
    sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id     INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    pct             REAL NOT NULL DEFAULT 0,
    locked          INTEGER NOT NULL DEFAULT 0,
    is_roth         INTEGER NOT NULL DEFAULT 0,
    target_amount   REAL,        -- NULL = no goal
    current_balance REAL NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0
);
"""

DEFAULT_SETTINGS = {
    "roth_limit": "7000",
    "default_tax_rate": "22",
    "active_scenario_id": "",  # set after seeding
}


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init():
    con = connect()
    with con:
        con.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
        if con.execute("SELECT COUNT(*) FROM scenarios").fetchone()[0] == 0:
            sid = con.execute("INSERT INTO scenarios(name) VALUES ('Current')").lastrowid
            con.execute(
                "INSERT INTO income_streams(scenario_id, name, annual_gross, slider_min, slider_max, sort_order)"
                " VALUES (?, 'IT Job Salary', 55000, 40000, 90000, 0)",
                (sid,),
            )
            defaults = [
                ("Living Expenses", 60, 0, None, 0),
                ("Roth IRA", 10, 1, None, 1),
                ("Emergency Fund", 15, 0, 15000, 2),
                ("Brokerage", 10, 0, None, 3),
                ("Truck Fund", 5, 0, 30000, 4),
            ]
            for name, pct, is_roth, target, sort in defaults:
                con.execute(
                    "INSERT INTO categories(scenario_id, name, pct, is_roth, target_amount, sort_order)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (sid, name, pct, is_roth, target, sort),
                )
            con.execute("UPDATE settings SET value = ? WHERE key = 'active_scenario_id'", (str(sid),))
    con.close()


# ---------- settings ----------

def get_settings(con) -> dict:
    return {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM settings")}


def set_settings(con, updates: dict):
    for k, v in updates.items():
        con.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, str(v)),
        )


# ---------- scenario snapshots ----------

def scenario_data(con, scenario_id: int) -> dict | None:
    row = con.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
    if row is None:
        return None
    streams = con.execute(
        "SELECT * FROM income_streams WHERE scenario_id = ? ORDER BY sort_order, id", (scenario_id,)
    ).fetchall()
    cats = con.execute(
        "SELECT * FROM categories WHERE scenario_id = ? ORDER BY sort_order, id", (scenario_id,)
    ).fetchall()
    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "income_streams": [dict(s) for s in streams],
        "categories": [dict(c) for c in cats],
    }


def duplicate_scenario(con, source_id: int, new_name: str) -> int:
    new_id = con.execute("INSERT INTO scenarios(name) VALUES (?)", (new_name,)).lastrowid
    con.execute(
        "INSERT INTO income_streams(scenario_id, name, annual_gross, slider_min, slider_max, tax_rate, sort_order)"
        " SELECT ?, name, annual_gross, slider_min, slider_max, tax_rate, sort_order"
        " FROM income_streams WHERE scenario_id = ?",
        (new_id, source_id),
    )
    con.execute(
        "INSERT INTO categories(scenario_id, name, pct, locked, is_roth, target_amount, current_balance, sort_order)"
        " SELECT ?, name, pct, locked, is_roth, target_amount, current_balance, sort_order"
        " FROM categories WHERE scenario_id = ?",
        (new_id, source_id),
    )
    return new_id


# ---------- export / import ----------

def export_all(con) -> dict:
    return {
        "settings": get_settings(con),
        "scenarios": [
            scenario_data(con, r["id"])
            for r in con.execute("SELECT id FROM scenarios ORDER BY id")
        ],
    }


def import_all(con, data: dict):
    con.execute("DELETE FROM categories")
    con.execute("DELETE FROM income_streams")
    con.execute("DELETE FROM scenarios")
    con.execute("DELETE FROM settings")
    set_settings(con, data.get("settings", {}))
    id_map = {}
    for sc in data.get("scenarios", []):
        new_id = con.execute(
            "INSERT INTO scenarios(name, created_at) VALUES (?, COALESCE(?, datetime('now')))",
            (sc["name"], sc.get("created_at")),
        ).lastrowid
        id_map[sc.get("id")] = new_id
        for i, s in enumerate(sc.get("income_streams", [])):
            con.execute(
                "INSERT INTO income_streams(scenario_id, name, annual_gross, slider_min, slider_max, tax_rate, sort_order)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id, s["name"], s["annual_gross"], s.get("slider_min", 0),
                 s.get("slider_max", 200000), s.get("tax_rate"), s.get("sort_order", i)),
            )
        for i, c in enumerate(sc.get("categories", [])):
            con.execute(
                "INSERT INTO categories(scenario_id, name, pct, locked, is_roth, target_amount, current_balance, sort_order)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (new_id, c["name"], c.get("pct", 0), c.get("locked", 0), c.get("is_roth", 0),
                 c.get("target_amount"), c.get("current_balance", 0), c.get("sort_order", i)),
            )
    # re-point active scenario at its new id (or first scenario)
    old_active = data.get("settings", {}).get("active_scenario_id", "")
    new_active = id_map.get(int(old_active)) if str(old_active).isdigit() else None
    if new_active is None:
        row = con.execute("SELECT id FROM scenarios ORDER BY id LIMIT 1").fetchone()
        new_active = row["id"] if row else ""
    set_settings(con, {"active_scenario_id": new_active})
