"""CashFlow — personal finance allocation tool. Run: python main.py"""
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db

db.init()
app = FastAPI(title="CashFlow")

STATIC = Path(__file__).parent / "static"


# ---------- models ----------

class StreamIn(BaseModel):
    name: str = "New Income"
    annual_gross: float = 50000
    slider_min: float = 0
    slider_max: float = 150000
    tax_rate: float | None = None


class StreamPatch(BaseModel):
    name: str | None = None
    annual_gross: float | None = None
    slider_min: float | None = None
    slider_max: float | None = None
    tax_rate: float | None = None
    clear_tax_rate: bool = False


class CategoryIn(BaseModel):
    name: str = "New Category"
    pct: float = 0
    locked: bool = False
    is_roth: bool = False
    target_amount: float | None = None
    current_balance: float = 0


class CategoryPatch(BaseModel):
    name: str | None = None
    pct: float | None = None
    locked: bool | None = None
    is_roth: bool | None = None
    target_amount: float | None = None
    clear_target: bool = False
    current_balance: float | None = None


class PctBatch(BaseModel):
    # {category_id: pct} — written atomically after a drag settles
    pcts: dict[int, float]


class ScenarioIn(BaseModel):
    name: str
    duplicate_from: int | None = None


# ---------- helpers ----------

def _scenario_or_404(con, sid: int) -> dict:
    data = db.scenario_data(con, sid)
    if data is None:
        raise HTTPException(404, f"scenario {sid} not found")
    return data


# ---------- state ----------

@app.get("/api/state")
def get_state():
    """Everything the UI needs on load."""
    con = db.connect()
    try:
        settings = db.get_settings(con)
        scenarios = [dict(r) for r in con.execute("SELECT id, name, created_at FROM scenarios ORDER BY id")]
        active = settings.get("active_scenario_id", "")
        active_id = int(active) if str(active).isdigit() else (scenarios[0]["id"] if scenarios else None)
        return {
            "settings": settings,
            "scenarios": scenarios,
            "active": db.scenario_data(con, active_id) if active_id else None,
        }
    finally:
        con.close()


@app.put("/api/settings")
def put_settings(updates: dict = Body(...)):
    con = db.connect()
    try:
        with con:
            db.set_settings(con, updates)
        return db.get_settings(con)
    finally:
        con.close()


# ---------- scenarios ----------

@app.post("/api/scenarios")
def create_scenario(body: ScenarioIn):
    con = db.connect()
    try:
        with con:
            if body.duplicate_from is not None:
                _scenario_or_404(con, body.duplicate_from)
                sid = db.duplicate_scenario(con, body.duplicate_from, body.name)
            else:
                sid = con.execute("INSERT INTO scenarios(name) VALUES (?)", (body.name,)).lastrowid
        return db.scenario_data(con, sid)
    finally:
        con.close()


@app.get("/api/scenarios/{sid}")
def get_scenario(sid: int):
    con = db.connect()
    try:
        return _scenario_or_404(con, sid)
    finally:
        con.close()


@app.put("/api/scenarios/{sid}/activate")
def activate_scenario(sid: int):
    con = db.connect()
    try:
        data = _scenario_or_404(con, sid)
        with con:
            db.set_settings(con, {"active_scenario_id": sid})
        return data
    finally:
        con.close()


@app.put("/api/scenarios/{sid}")
def rename_scenario(sid: int, body: dict = Body(...)):
    con = db.connect()
    try:
        _scenario_or_404(con, sid)
        with con:
            con.execute("UPDATE scenarios SET name = ? WHERE id = ?", (body["name"], sid))
        return db.scenario_data(con, sid)
    finally:
        con.close()


@app.delete("/api/scenarios/{sid}")
def delete_scenario(sid: int):
    con = db.connect()
    try:
        _scenario_or_404(con, sid)
        if con.execute("SELECT COUNT(*) FROM scenarios").fetchone()[0] <= 1:
            raise HTTPException(400, "can't delete the last scenario")
        with con:
            con.execute("DELETE FROM scenarios WHERE id = ?", (sid,))
            settings = db.get_settings(con)
            if settings.get("active_scenario_id") == str(sid):
                row = con.execute("SELECT id FROM scenarios ORDER BY id LIMIT 1").fetchone()
                db.set_settings(con, {"active_scenario_id": row["id"]})
        return {"ok": True}
    finally:
        con.close()


# ---------- income streams ----------

@app.post("/api/scenarios/{sid}/streams")
def create_stream(sid: int, body: StreamIn):
    con = db.connect()
    try:
        _scenario_or_404(con, sid)
        with con:
            order = con.execute(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM income_streams WHERE scenario_id = ?", (sid,)
            ).fetchone()[0]
            new_id = con.execute(
                "INSERT INTO income_streams(scenario_id, name, annual_gross, slider_min, slider_max, tax_rate, sort_order)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, body.name, body.annual_gross, body.slider_min, body.slider_max, body.tax_rate, order),
            ).lastrowid
        return dict(con.execute("SELECT * FROM income_streams WHERE id = ?", (new_id,)).fetchone())
    finally:
        con.close()


@app.patch("/api/streams/{stream_id}")
def patch_stream(stream_id: int, body: StreamPatch):
    con = db.connect()
    try:
        row = con.execute("SELECT * FROM income_streams WHERE id = ?", (stream_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "stream not found")
        fields = body.model_dump(exclude_none=True, exclude={"clear_tax_rate"})
        with con:
            for k, v in fields.items():
                con.execute(f"UPDATE income_streams SET {k} = ? WHERE id = ?", (v, stream_id))
            if body.clear_tax_rate:
                con.execute("UPDATE income_streams SET tax_rate = NULL WHERE id = ?", (stream_id,))
        return dict(con.execute("SELECT * FROM income_streams WHERE id = ?", (stream_id,)).fetchone())
    finally:
        con.close()


@app.delete("/api/streams/{stream_id}")
def delete_stream(stream_id: int):
    con = db.connect()
    try:
        with con:
            cur = con.execute("DELETE FROM income_streams WHERE id = ?", (stream_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "stream not found")
        return {"ok": True}
    finally:
        con.close()


# ---------- categories ----------

@app.post("/api/scenarios/{sid}/categories")
def create_category(sid: int, body: CategoryIn):
    con = db.connect()
    try:
        _scenario_or_404(con, sid)
        with con:
            order = con.execute(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM categories WHERE scenario_id = ?", (sid,)
            ).fetchone()[0]
            new_id = con.execute(
                "INSERT INTO categories(scenario_id, name, pct, locked, is_roth, target_amount, current_balance, sort_order)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, body.name, body.pct, int(body.locked), int(body.is_roth),
                 body.target_amount, body.current_balance, order),
            ).lastrowid
        return dict(con.execute("SELECT * FROM categories WHERE id = ?", (new_id,)).fetchone())
    finally:
        con.close()


@app.patch("/api/categories/{cat_id}")
def patch_category(cat_id: int, body: CategoryPatch):
    con = db.connect()
    try:
        row = con.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "category not found")
        fields = body.model_dump(exclude_none=True, exclude={"clear_target"})
        with con:
            for k, v in fields.items():
                if isinstance(v, bool):
                    v = int(v)
                con.execute(f"UPDATE categories SET {k} = ? WHERE id = ?", (v, cat_id))
            if body.clear_target:
                con.execute("UPDATE categories SET target_amount = NULL WHERE id = ?", (cat_id,))
        return dict(con.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone())
    finally:
        con.close()


@app.put("/api/scenarios/{sid}/pcts")
def put_pcts(sid: int, body: PctBatch):
    """Atomic write of all category percentages after a drag settles."""
    con = db.connect()
    try:
        _scenario_or_404(con, sid)
        with con:
            for cat_id, pct in body.pcts.items():
                con.execute(
                    "UPDATE categories SET pct = ? WHERE id = ? AND scenario_id = ?",
                    (pct, cat_id, sid),
                )
        return {"ok": True}
    finally:
        con.close()


@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: int):
    con = db.connect()
    try:
        with con:
            cur = con.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "category not found")
        return {"ok": True}
    finally:
        con.close()


# ---------- export / import ----------

@app.get("/api/export")
def export_data():
    con = db.connect()
    try:
        return JSONResponse(
            db.export_all(con),
            headers={"Content-Disposition": "attachment; filename=cashflow-backup.json"},
        )
    finally:
        con.close()


@app.post("/api/import")
def import_data(data: dict = Body(...)):
    if "scenarios" not in data:
        raise HTTPException(400, "invalid backup: missing 'scenarios'")
    con = db.connect()
    try:
        with con:
            db.import_all(con, data)
        return {"ok": True}
    finally:
        con.close()


# ---------- static ----------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
