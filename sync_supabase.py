from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import os
import sqlite3
import sys


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "shift.db"
CONFIG_PATH = ROOT / "supabase.local.json"


def load_config():
    config = {}
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {
        "url": (os.environ.get("SUPABASE_URL") or config.get("url") or "").rstrip("/"),
        "service_key": os.environ.get("SUPABASE_SERVICE_KEY") or config.get("service_key") or "",
    }


def require_config():
    config = load_config()
    if not config["url"] or not config["service_key"]:
        raise ValueError("Supabase接続情報を supabase.local.json または環境変数に設定してください")
    return config


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def request(table, query="", method="GET", body=None, prefer=None):
    config = require_config()
    url = f"{config['url']}/rest/v1/{table}"
    if query:
        url = f"{url}?{query}"
    headers = {
        "apikey": config["service_key"],
        "Authorization": f"Bearer {config['service_key']}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req) as res:
        if res.status == 204:
            return None
        text = res.read().decode("utf-8")
        return json.loads(text) if text else None


def upsert(table, records, conflict):
    if not records:
        return
    query = urlencode({"on_conflict": conflict})
    request(
        table,
        query,
        method="POST",
        body=records,
        prefer="resolution=merge-duplicates,return=minimal",
    )


def insert(table, records):
    if not records:
        return
    request(table, method="POST", body=records, prefer="return=minimal")


def push_public_data():
    with connect() as conn:
        members = rows(conn.execute("SELECT id, name, can_drive, active FROM members"))
        venues = rows(conn.execute("SELECT id, name, capacity FROM venues"))
        months = rows(conn.execute("SELECT id, year, month, survey_status, survey_deadline, schedule_published FROM months"))
        survey_dates = rows(conn.execute("SELECT id, month_id, date FROM survey_dates"))
        assignments = rows(conn.execute("SELECT month_id, date, venue_id, slot, member_id FROM assignments"))

    for member in members:
        member["can_drive"] = bool(member["can_drive"])
        member["active"] = bool(member["active"])
    for month in months:
        month["schedule_published"] = bool(month["schedule_published"])

    upsert("members", members, "id")
    upsert("venues", venues, "id")
    upsert("months", months, "id")
    delete("survey_dates", "id=not.is.null")
    insert("survey_dates", survey_dates)
    upsert("assignments", assignments, "month_id,date,venue_id,slot")
    print("公開データをSupabaseへ同期しました")


def fetch_all(table, query="select=*"):
    return request(table, query) or []


def test_connection():
    fetch_all("venues", "select=id&limit=1")
    print("Supabase接続を確認しました")


def delete(table, query):
    request(table, query, method="DELETE", prefer="return=minimal")


def upsert_response(record):
    saved = request(
        "responses",
        urlencode({"on_conflict": "month_id,member_id"}),
        method="POST",
        body=[record],
        prefer="resolution=merge-duplicates,return=representation",
    )
    return saved[0]


def push_responses():
    with connect() as conn:
        responses = rows(conn.execute("SELECT id, month_id, member_id, updated_at FROM responses ORDER BY id"))
        response_days = rows(conn.execute("SELECT response_id, date, availability FROM response_days ORDER BY date"))

    days_by_response = {}
    for day in response_days:
        days_by_response.setdefault(day["response_id"], []).append(day)

    for response in responses:
        local_id = response.pop("id")
        saved = upsert_response(response)
        remote_id = saved["id"]
        delete("response_days", urlencode({"response_id": f"eq.{remote_id}"}))
        days = [
            {
                "response_id": remote_id,
                "date": day["date"],
                "availability": day["availability"],
            }
            for day in days_by_response.get(local_id, [])
        ]
        upsert("response_days", days, "response_id,date")
    print("ローカル回答をSupabaseへ同期しました")


def pull_responses():
    responses = fetch_all("responses", "select=*")
    response_days = fetch_all("response_days", "select=*")
    with connect() as conn:
        response_id_map = {}
        for response in responses:
            existing = conn.execute(
                "SELECT id FROM responses WHERE month_id = ? AND member_id = ?",
                (response["month_id"], response["member_id"]),
            ).fetchone()
            if existing:
                local_id = existing["id"]
                conn.execute(
                    "UPDATE responses SET updated_at = ? WHERE id = ?",
                    (response["updated_at"], local_id),
                )
            else:
                cur = conn.execute(
                    """
                    INSERT INTO responses(month_id, member_id, updated_at)
                    VALUES(:month_id, :member_id, :updated_at)
                    """,
                    response,
                )
                local_id = cur.lastrowid
            response_id_map[response["id"]] = local_id

        for local_id in set(response_id_map.values()):
            conn.execute("DELETE FROM response_days WHERE response_id = ?", (local_id,))
        conn.executemany(
            """
            INSERT INTO response_days(response_id, date, availability)
            VALUES(:response_id, :date, :availability)
            """,
            [
                {
                    "response_id": response_id_map[day["response_id"]],
                    "date": day["date"],
                    "availability": day["availability"],
                }
                for day in response_days
                if day["response_id"] in response_id_map
            ],
        )
    print("オンライン回答をローカルへ取り込みました")


def sync_all():
    push_public_data()
    push_responses()
    pull_responses()


if __name__ == "__main__":
    require_config()
    command = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if command == "push":
        push_public_data()
    elif command == "push-responses":
        push_responses()
    elif command == "pull":
        pull_responses()
    elif command == "sync":
        sync_all()
    else:
        raise SystemExit("使い方: python sync_supabase.py [push|push-responses|pull|sync]")
