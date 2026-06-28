from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import secrets
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "shift.db"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "hirugaku-admin")
ADMIN_SESSIONS = set()


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                can_drive INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS venues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                capacity INTEGER NOT NULL DEFAULT 3
            );
            CREATE TABLE IF NOT EXISTS months (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                survey_status TEXT NOT NULL DEFAULT 'draft',
                survey_deadline TEXT,
                schedule_published INTEGER NOT NULL DEFAULT 0,
                UNIQUE(year, month)
            );
            CREATE TABLE IF NOT EXISTS survey_dates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
                date TEXT NOT NULL,
                UNIQUE(month_id, date)
            );
            CREATE TABLE IF NOT EXISTS responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
                member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE(month_id, member_id)
            );
            CREATE TABLE IF NOT EXISTS response_days (
                response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
                date TEXT NOT NULL,
                availability TEXT NOT NULL CHECK(availability IN ('ok', 'maybe', 'ng')),
                PRIMARY KEY(response_id, date)
            );
            CREATE TABLE IF NOT EXISTS assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month_id INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
                date TEXT NOT NULL,
                venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
                slot INTEGER NOT NULL,
                member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
                UNIQUE(month_id, date, venue_id, slot)
            );
            """
        )
        for name in ["穂波", "二瀬", "庄内"]:
            conn.execute("INSERT OR IGNORE INTO venues(name, capacity) VALUES(?, 3)", (name,))
        count = conn.execute("SELECT COUNT(*) FROM members").fetchone()[0]
        if count == 0:
            sample_members = [("山田", 1), ("佐藤", 0), ("田中", 1), ("鈴木", 0), ("高橋", 0)]
            conn.executemany("INSERT INTO members(name, can_drive) VALUES(?, ?)", sample_members)


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def body_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length == 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def bootstrap():
    with connect() as conn:
        data = {
            "members": rows(conn.execute("SELECT * FROM members WHERE active = 1 ORDER BY name")),
            "venues": rows(conn.execute("SELECT * FROM venues ORDER BY id")),
            "months": rows(conn.execute("SELECT * FROM months ORDER BY year DESC, month DESC")),
            "survey_dates": rows(conn.execute("SELECT * FROM survey_dates ORDER BY date")),
            "responses": rows(
                conn.execute(
                    """
                    SELECT r.id, r.month_id, r.member_id, r.updated_at, m.name AS member_name
                    FROM responses r JOIN members m ON m.id = r.member_id
                    ORDER BY r.updated_at DESC
                    """
                )
            ),
            "response_days": rows(conn.execute("SELECT * FROM response_days ORDER BY date")),
            "assignments": rows(conn.execute("SELECT * FROM assignments ORDER BY date, venue_id, slot")),
        }
    return data


def upsert_month(payload):
    with connect() as conn:
        year = int(payload["year"])
        month = int(payload["month"])
        conn.execute(
            """
            INSERT INTO months(year, month, survey_status, survey_deadline, schedule_published)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(year, month) DO UPDATE SET
                survey_status = excluded.survey_status,
                survey_deadline = excluded.survey_deadline,
                schedule_published = excluded.schedule_published
            """,
            (
                year,
                month,
                payload.get("survey_status", "draft"),
                payload.get("survey_deadline") or None,
                1 if payload.get("schedule_published") else 0,
            ),
        )
        month_id = conn.execute("SELECT id FROM months WHERE year = ? AND month = ?", (year, month)).fetchone()["id"]
        dates = sorted(set(payload.get("dates", [])))
        conn.execute("DELETE FROM survey_dates WHERE month_id = ?", (month_id,))
        conn.executemany("INSERT INTO survey_dates(month_id, date) VALUES(?, ?)", [(month_id, d) for d in dates])
    return {"ok": True, "month_id": month_id}


def create_member(payload):
    name = payload["name"].strip()
    if not name:
        raise ValueError("氏名を入力してください")
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO members(name, can_drive, active)
            VALUES(?, ?, 1)
            ON CONFLICT(name) DO UPDATE SET
                can_drive = excluded.can_drive,
                active = 1
            """,
            (name, 1 if payload.get("can_drive") else 0),
        )
    return {"ok": True}


def update_member(payload):
    with connect() as conn:
        conn.execute(
            "UPDATE members SET name = ?, can_drive = ? WHERE id = ?",
            (payload["name"].strip(), 1 if payload.get("can_drive") else 0, int(payload["id"])),
        )
    return {"ok": True}


def delete_member(payload):
    with connect() as conn:
        conn.execute("UPDATE members SET active = 0 WHERE id = ?", (int(payload["id"]),))
    return {"ok": True}


def save_response(payload):
    month_id = int(payload["month_id"])
    member_id = int(payload["member_id"])
    answers = payload.get("answers", {})
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO responses(month_id, member_id, updated_at)
            VALUES(?, ?, datetime('now', 'localtime'))
            ON CONFLICT(month_id, member_id) DO UPDATE SET updated_at = datetime('now', 'localtime')
            """,
            (month_id, member_id),
        )
        response_id = conn.execute(
            "SELECT id FROM responses WHERE month_id = ? AND member_id = ?", (month_id, member_id)
        ).fetchone()["id"]
        conn.execute("DELETE FROM response_days WHERE response_id = ?", (response_id,))
        conn.executemany(
            "INSERT INTO response_days(response_id, date, availability) VALUES(?, ?, ?)",
            [(response_id, date, value) for date, value in answers.items()],
        )
    return {"ok": True}


def delete_response(payload):
    month_id = int(payload["month_id"])
    member_id = int(payload["member_id"])
    with connect() as conn:
        response = conn.execute(
            "SELECT id FROM responses WHERE month_id = ? AND member_id = ?", (month_id, member_id)
        ).fetchone()
        if response:
            conn.execute("DELETE FROM response_days WHERE response_id = ?", (response["id"],))
            conn.execute("DELETE FROM responses WHERE id = ?", (response["id"],))
    return {"ok": True}


def save_assignments(payload):
    month_id = int(payload["month_id"])
    date = payload["date"]
    entries = payload.get("assignments", [])
    with connect() as conn:
        for entry in entries:
            conn.execute(
                """
                INSERT INTO assignments(month_id, date, venue_id, slot, member_id)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(month_id, date, venue_id, slot) DO UPDATE SET member_id = excluded.member_id
                """,
                (
                    month_id,
                    date,
                    int(entry["venue_id"]),
                    int(entry["slot"]),
                    int(entry["member_id"]) if entry.get("member_id") else None,
                ),
            )
    return {"ok": True}


def sync_supabase(command):
    import sync_supabase as sync_client

    sync_client.require_config()
    if command == "push":
        sync_client.push_public_data()
    elif command == "pull":
        sync_client.pull_responses()
    elif command == "sync":
        sync_client.sync_all()
    else:
        raise ValueError("unknown sync command")
    return {"ok": True}


def sync_push(_payload):
    return sync_supabase("push")


def sync_pull(_payload):
    return sync_supabase("pull")


def sync_all(_payload):
    return sync_supabase("sync")


def test_supabase(_payload):
    import sync_supabase as sync_client

    sync_client.test_connection()
    return {"ok": True}


def build_public_files(_payload):
    import build_public

    build_public.copy_public_files()
    return {"ok": True}


def save_supabase_config(payload):
    url = (payload.get("url") or "").strip().rstrip("/")
    anon_key = (payload.get("anon_key") or "").strip()
    service_key = (payload.get("service_key") or "").strip()
    if not url or not anon_key or not service_key:
        raise ValueError("Supabase URL、anon key、service_role keyを入力してください")

    local_config = {
        "url": url,
        "service_key": service_key,
    }
    (ROOT / "supabase.local.json").write_text(
        json.dumps(local_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    public_config = f"""window.HIRUGAKU_ONLINE = {{
  enabled: true,
  supabaseUrl: {json.dumps(url, ensure_ascii=False)},
  supabaseAnonKey: {json.dumps(anon_key, ensure_ascii=False)},
}};
"""
    (ROOT / "static" / "online-config.js").write_text(public_config, encoding="utf-8")
    public_static = ROOT / "public" / "static"
    if public_static.exists():
        (public_static / "online-config.js").write_text(public_config, encoding="utf-8")
    return {"ok": True}


def supabase_status():
    local_config = {}
    local_path = ROOT / "supabase.local.json"
    if local_path.exists():
        try:
            local_config = json.loads(local_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            local_config = {}

    public_config = (ROOT / "static" / "online-config.js").read_text(encoding="utf-8")
    return {
        "ok": True,
        "url": local_config.get("url") or "",
        "has_anon_key": "supabaseAnonKey" in public_config and "enabled: true" in public_config,
        "has_service_key": bool(local_config.get("service_key")),
    }


API_POST = {
    "/api/month": upsert_month,
    "/api/member": create_member,
    "/api/member/update": update_member,
    "/api/member/delete": delete_member,
    "/api/response": save_response,
    "/api/response/delete": delete_response,
    "/api/assignments": save_assignments,
    "/api/sync/push": sync_push,
    "/api/sync/pull": sync_pull,
    "/api/sync/all": sync_all,
    "/api/sync/test": test_supabase,
    "/api/public/build": build_public_files,
    "/api/supabase/config": save_supabase_config,
}
ADMIN_POST_PATHS = set(API_POST) - {"/api/response", "/api/response/delete"}


def admin_login(data):
    if data.get("password") != ADMIN_PASSWORD:
        return {"ok": False, "error": "パスワードが違います"}
    token = secrets.token_urlsafe(32)
    ADMIN_SESSIONS.add(token)
    return {"ok": True, "token": token}


def has_admin_session(handler):
    token = handler.headers.get("X-Admin-Token", "")
    return bool(token and token in ADMIN_SESSIONS)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, payload, status=200):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/bootstrap":
            self.send_json(bootstrap())
            return
        if path == "/api/supabase/status":
            if not has_admin_session(self):
                self.send_json({"ok": False, "error": "管理者パスワードの確認が必要です"}, 401)
                return
            self.send_json(supabase_status())
            return
        if path in ["/", "/user", "/admin"] or path.startswith("/user/") or path.startswith("/admin/"):
            self.path = "/static/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/admin/login":
            try:
                self.send_json(admin_login(body_json(self)))
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, 400)
            return
        if path not in API_POST:
            self.send_json({"ok": False, "error": "unknown endpoint"}, 404)
            return
        if path in ADMIN_POST_PATHS and not has_admin_session(self):
            self.send_json({"ok": False, "error": "管理者パスワードの確認が必要です"}, 401)
            return
        try:
            self.send_json(API_POST[path](body_json(self)))
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 400)


if __name__ == "__main__":
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"昼学シフトシステム: http://127.0.0.1:{port}")
    server.serve_forever()
