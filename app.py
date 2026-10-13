from flask import Flask, jsonify, request, send_from_directory
from scheduler import generate_timetable, validate_input
import copy

app = Flask(__name__, static_folder="frontend", static_url_path="")

# ---------------------------------------------------------------------------
# In-memory publication state
# ---------------------------------------------------------------------------
_draft     = None   # last generated result (entries + issues + summary)
_published = None   # coordinator-approved snapshot


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory("frontend", "index.html")


# ---------------------------------------------------------------------------
# Sample dataset — M.Sc DFIS with batches + fixed session
# ---------------------------------------------------------------------------

SAMPLE = {
    "working_hours": {"start": "09:00", "end": "17:00"},
    "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "slots": [
        {"id": "09:00", "label": "09:00 – 10:00"},
        {"id": "10:00", "label": "10:00 – 11:00"},
        {"id": "11:00", "label": "11:00 – 12:00"},
        {"id": "12:00", "label": "12:00 – 13:00"},
        {"id": "13:00", "label": "13:00 – 14:00", "is_break": True},
        {"id": "14:00", "label": "14:00 – 15:00"},
        {"id": "15:00", "label": "15:00 – 16:00"},
        {"id": "16:00", "label": "16:00 – 17:00"},
    ],
    "rooms": [
        {"id": "LH-101",  "capacity": 80, "type": "classroom"},
        {"id": "LH-102",  "capacity": 60, "type": "classroom"},
        {"id": "LH-103",  "capacity": 40, "type": "classroom"},
        {"id": "CR-201",  "capacity": 30, "type": "classroom"},
        {"id": "CR-202",  "capacity": 30, "type": "classroom"},
        # Large PC labs that can accommodate whole-class practicals
        {"id": "LAB-CS1", "capacity": 65, "type": "lab"},
        {"id": "LAB-CS2", "capacity": 60, "type": "lab"},
        # Specialist / smaller labs
        {"id": "LAB-NET", "capacity": 30, "type": "lab"},
        {"id": "LAB-FOR", "capacity": 25, "type": "lab"},
    ],
    "classes": [
        {"id": "CS1",  "name": "B.Tech CS  – Sem 1",   "strength": 60},
        {"id": "CS3",  "name": "B.Tech CS  – Sem 3",   "strength": 55},
        {"id": "IT1",  "name": "B.Tech IT  – Sem 1",   "strength": 50},
        # M.Sc DFIS — 40 students split into two practical batches of 20
        {
            "id": "DF1",
            "name": "M.Sc DFIS – Sem 1",
            "strength": 40,
            "batches": [
                {"id": "DF1-B1", "name": "Batch A", "strength": 20},
                {"id": "DF1-B2", "name": "Batch B", "strength": 20},
            ],
        },
        {"id": "CYB1", "name": "M.Tech Cyber – Sem 1", "strength": 18},
    ],
    "subjects": [
        # ── B.Tech CS Sem 1 ───────────────────────────────────────────
        {"id": "CS101", "name": "Programming Fundamentals",
         "class_id": "CS1", "faculty": "Dr. Patel",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "MA101", "name": "Mathematics I",
         "class_id": "CS1", "faculty": "Prof. Shah",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "PH101", "name": "Engineering Physics",
         "class_id": "CS1", "faculty": "Dr. Joshi",
         "weekly_periods": 2, "room_type": "classroom", "session_type": "theory"},
        {"id": "CP101", "name": "C Programming Lab",
         "class_id": "CS1", "faculty": "Dr. Patel",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        # ── B.Tech CS Sem 3 ───────────────────────────────────────────
        {"id": "CS301", "name": "Data Structures",
         "class_id": "CS3", "faculty": "Prof. Verma",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "CS302", "name": "Database Systems",
         "class_id": "CS3", "faculty": "Dr. Kapoor",
         "weekly_periods": 2, "room_type": "classroom", "session_type": "theory"},
        {"id": "CS303", "name": "Operating Systems",
         "class_id": "CS3", "faculty": "Dr. Rao",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "CS3L1", "name": "DBMS Lab",
         "class_id": "CS3", "faculty": "Dr. Kapoor",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        {"id": "CS3L2", "name": "OS Lab",
         "class_id": "CS3", "faculty": "Dr. Rao",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        # ── B.Tech IT Sem 1 ───────────────────────────────────────────
        {"id": "IT101", "name": "Web Technologies",
         "class_id": "IT1", "faculty": "Prof. Nair",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "IT102", "name": "Discrete Mathematics",
         "class_id": "IT1", "faculty": "Prof. Shah",
         "weekly_periods": 2, "room_type": "classroom", "session_type": "theory"},
        {"id": "IT1L1", "name": "Web Dev Lab",
         "class_id": "IT1", "faculty": "Prof. Nair",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        # ── M.Sc DFIS Sem 1 ───────────────────────────────────────────
        # 3 whole-class theory periods
        {"id": "DF101", "name": "Digital Forensics",
         "class_id": "DF1", "faculty": "Dr. Mehta",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        # 1 fixed whole-class theory session (coordinator pre-assigned)
        {"id": "DF102", "name": "Cyber Law & Ethics",
         "class_id": "DF1", "faculty": "Dr. Iyer",
         "weekly_periods": 2, "room_type": "classroom", "session_type": "theory",
         "fixed": {"day": "Wednesday", "slot": "09:00", "room": "LH-103"}},
        # Forensics Lab — 1 session per batch per week (2 consecutive periods each)
        {"id": "DF1L1-B1", "name": "Forensics Lab (Batch A)",
         "class_id": "DF1", "batch_id": "DF1-B1", "faculty": "Dr. Mehta",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        {"id": "DF1L1-B2", "name": "Forensics Lab (Batch B)",
         "class_id": "DF1", "batch_id": "DF1-B2", "faculty": "Dr. Mehta",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
        # ── M.Tech Cyber Sem 1 ────────────────────────────────────────
        {"id": "CY101", "name": "Network Security",
         "class_id": "CYB1", "faculty": "Dr. Rao",
         "weekly_periods": 3, "room_type": "classroom", "session_type": "theory"},
        {"id": "CY102", "name": "Cryptography",
         "class_id": "CYB1", "faculty": "Dr. Iyer",
         "weekly_periods": 2, "room_type": "classroom", "session_type": "theory"},
        {"id": "CY1L1", "name": "Penetration Testing Lab",
         "class_id": "CYB1", "faculty": "Dr. Rao",
         "weekly_periods": 1, "room_type": "lab", "duration": 2, "session_type": "practical"},
    ],
    "faculty_unavailable": [
        {"faculty": "Dr. Patel",  "day": "Monday",    "slot": "09:00"},
        {"faculty": "Prof. Shah", "day": "Wednesday",  "slot": "11:00"},
        {"faculty": "Dr. Mehta",  "day": "Friday",     "slot": "14:00"},
        {"faculty": "Dr. Mehta",  "day": "Friday",     "slot": "15:00"},
        {"faculty": "Dr. Rao",    "day": "Tuesday",    "slot": "09:00"},
    ],
    # Example: Dr. Iyer only available afternoons on Monday
    "faculty_available_ranges": [
        {"faculty": "Dr. Iyer", "day": "Monday", "from": "14:00", "to": "17:00"},
    ],
    # Example: Prof. Shah capped at 3 periods per day
    "faculty_constraints": [
        {"faculty": "Prof. Shah", "max_daily_periods": 3},
    ],
}


@app.get("/api/sample")
def sample():
    return jsonify(SAMPLE)


# ---------------------------------------------------------------------------
# Validate input data
# ---------------------------------------------------------------------------

@app.post("/api/validate")
def validate():
    payload = request.get_json(silent=True) or {}
    warnings = validate_input(payload)
    return jsonify({"warnings": warnings, "valid": len(warnings) == 0})


# ---------------------------------------------------------------------------
# Generate timetable
# ---------------------------------------------------------------------------

@app.post("/api/generate")
def generate():
    global _draft
    payload = request.get_json(silent=True) or {}
    result = generate_timetable(payload)
    _draft = copy.deepcopy(result)
    return jsonify(result), (200 if result.get("success") else 422)


# ---------------------------------------------------------------------------
# Manual adjust — move / lock a single entry
# ---------------------------------------------------------------------------

@app.post("/api/adjust")
def adjust():
    """
    Body: {
      "entries": [...],   // full current entry list (client sends back after edits)
      "changed": {        // the single entry that was moved / locked
        "subject_id": "...", "day": "...", "start": "...", "room": "...",
        "locked": true|false
      }
    }
    Validates the changed entry for conflicts against all other entries.
    Returns {"ok": true} or {"ok": false, "conflicts": [...]}
    """
    body    = request.get_json(silent=True) or {}
    entries = body.get("entries", [])
    changed = body.get("changed", {})

    conflicts = _check_conflicts(entries, changed)
    return jsonify({"ok": len(conflicts) == 0, "conflicts": conflicts})


def _check_conflicts(entries, changed):
    """Return list of conflict description strings for the changed entry."""
    conflicts = []
    cid   = changed.get("subject_id")
    day   = changed.get("day")
    slots = changed.get("slots", [changed.get("start")] if changed.get("start") else [])
    room  = changed.get("room")
    fac   = changed.get("faculty")
    cls   = changed.get("class_id")
    bid   = changed.get("batch_id")

    for e in entries:
        if e.get("subject_id") == cid:
            continue   # skip self
        overlap = set(e.get("slots", [])) & set(slots)
        if e.get("day") != day or not overlap:
            continue
        if e.get("faculty") == fac:
            conflicts.append(
                f"Faculty '{fac}' is already teaching '{e['subject']}' at {day} {list(overlap)[0]}.")
        if e.get("room") == room and room:
            conflicts.append(
                f"Room '{room}' is already occupied by '{e['subject']}' at {day} {list(overlap)[0]}.")
        if e.get("class_id") == cls and not bid and not e.get("batch_id"):
            conflicts.append(
                f"Class '{cls}' already has '{e['subject']}' at {day} {list(overlap)[0]}.")
        if bid and e.get("batch_id") == bid:
            conflicts.append(
                f"Batch '{bid}' already has '{e['subject']}' at {day} {list(overlap)[0]}.")
        if bid and e.get("class_id") == cls and not e.get("batch_id"):
            conflicts.append(
                f"Whole-class session '{e['subject']}' conflicts with batch '{bid}' "
                f"at {day} {list(overlap)[0]}.")
        if not bid and e.get("batch_id") and e.get("class_id") == cls:
            conflicts.append(
                f"Batch session '{e['subject']}' conflicts with this whole-class session "
                f"at {day} {list(overlap)[0]}.")
    return conflicts


# ---------------------------------------------------------------------------
# Lock / unlock a session
# ---------------------------------------------------------------------------

@app.post("/api/lock")
def lock_session():
    """Body: {"subject_id": "...", "locked": true|false, "entries": [...]}"""
    body     = request.get_json(silent=True) or {}
    sid      = body.get("subject_id")
    locked   = bool(body.get("locked", True))
    entries  = body.get("entries", [])
    updated  = []
    for e in entries:
        entry = dict(e)
        if entry.get("subject_id") == sid:
            entry["locked"] = locked
        updated.append(entry)
    return jsonify({"entries": updated})


# ---------------------------------------------------------------------------
# Save draft
# ---------------------------------------------------------------------------

@app.post("/api/draft")
def save_draft():
    global _draft
    body   = request.get_json(silent=True) or {}
    _draft = copy.deepcopy(body)
    return jsonify({"saved": True})


@app.get("/api/draft")
def get_draft():
    if _draft is None:
        return jsonify({"entries": [], "issues": [], "summary": {}}), 404
    return jsonify(_draft)


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------

@app.post("/api/publish")
def publish():
    global _published
    body = request.get_json(silent=True) or {}
    entries = body.get("entries", [])
    # Final conflict check before publishing
    all_conflicts = []
    for i, e in enumerate(entries):
        for j, other in enumerate(entries):
            if i >= j:
                continue
            if e["day"] != other["day"]:
                continue
            overlap = set(e.get("slots", [])) & set(other.get("slots", []))
            if not overlap:
                continue
            if e["faculty"] == other["faculty"]:
                all_conflicts.append(
                    f"Faculty conflict: '{e['faculty']}' has overlapping sessions "
                    f"'{e['subject']}' and '{other['subject']}' on {e['day']}.")
            if e["room"] == other["room"] and e["room"]:
                all_conflicts.append(
                    f"Room conflict: '{e['room']}' used by "
                    f"'{e['subject']}' and '{other['subject']}' on {e['day']}.")

    if all_conflicts:
        return jsonify({"published": False, "conflicts": all_conflicts}), 409

    _published = copy.deepcopy({"entries": entries, "published_at": _now()})
    return jsonify({"published": True, "entries": entries})


@app.get("/api/publish")
def get_published():
    if _published is None:
        return jsonify({"entries": [], "published": False}), 404
    return jsonify({**_published, "published": True})


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _now():
    from datetime import datetime
    return datetime.utcnow().isoformat() + "Z"


if __name__ == "__main__":
    app.run(debug=True)
