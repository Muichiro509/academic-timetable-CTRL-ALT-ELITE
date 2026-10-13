# Schedulr — Academic Timetable Generator

A web-based system for automated academic timetable generation. The timetable coordinator enters departmental teaching requirements, available classrooms and laboratories, faculty availability, and university working hours. The system automatically generates a conflict-free timetable.

## Features

### Input management
- Set university working hours (start / end time)
- Toggle working days with one click (Mon–Sat chips)
- Add, edit, and remove time slots; mark any slot as a **lunch break** (automatically excluded from scheduling)
- Add, edit, and remove rooms with capacity and type (Classroom / Lab)
- Add, edit, and remove classes / sections with student strength
- Add, edit, and remove subjects with faculty name, weekly periods, room type, and session duration
- Add, edit, and remove faculty unavailability entries (faculty × day × slot)

### Scheduler constraints
| Constraint | Behaviour |
|---|---|
| Room type | Lab subjects placed only in labs; theory only in classrooms |
| Room capacity | Room capacity must be ≥ class strength |
| Faculty conflict | A faculty member cannot be in two places at once |
| Class conflict | A class cannot have two sessions simultaneously |
| Room conflict | A room cannot host two sessions simultaneously |
| Faculty unavailability | Configurable per faculty × day × slot |
| Lunch break | Marked slots are never used for scheduling |
| Consecutive practicals | Multi-period lab sessions occupy adjacent slots |
| Weekly spread | Sessions are distributed across the week (fewest-sessions-per-day heuristic) |

### Output
- **Timetable grid** — visual day × slot matrix; lab sessions shown in green
- **Per-class filter** — view the full grid or zoom into one class/section
- **Session list** — sortable table with day, time, subject, class, faculty, room, and type badges
- **Stats strip** — scheduled / unscheduled / total / subjects / rooms at a glance
- **Conflicts & Stats tab** — all unscheduled sessions with explanations; faculty and class load bar charts
- **CSV export** — download the currently visible sessions

### API endpoints
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sample` | Return a pre-built multi-department dataset |
| `POST` | `/api/validate` | Check input data for structural issues before scheduling |
| `POST` | `/api/generate` | Generate and return a timetable |

## Tech stack

- **Backend** — Python 3.10+ · Flask 3
- **Frontend** — HTML · CSS · vanilla JavaScript (no frameworks)
- **Algorithm** — greedy constraint-aware scheduler with practical-first ordering and weekly-spread heuristic

## Quick start (Windows)

```powershell
# 1. Create and activate a virtual environment (recommended)
py -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. Install dependencies
py -m pip install -r requirements.txt

# 3. Start the development server
py app.py
```

Open **http://127.0.0.1:5000** in a browser.

## Run the tests

```powershell
py -m pytest tests/ -v
# or
py -m unittest discover -s tests -v
```

The test suite covers: basic generation, room capacity, room type, faculty unavailability, no double-booking, consecutive practicals, break-slot exclusion, weekly spread, input validation, and multi-department scenarios (30 test cases).

## JSON data format (POST /api/generate)

```json
{
  "working_hours": { "start": "09:00", "end": "17:00" },
  "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  "slots": [
    { "id": "09:00", "label": "09:00 – 10:00" },
    { "id": "13:00", "label": "Lunch", "is_break": true }
  ],
  "rooms": [
    { "id": "LH-101", "capacity": 80, "type": "classroom" },
    { "id": "LAB-1",  "capacity": 30, "type": "lab" }
  ],
  "classes": [
    { "id": "CS1", "name": "B.Tech CS – Sem 1", "strength": 60 }
  ],
  "subjects": [
    { "id": "CS101", "name": "Programming", "class_id": "CS1",
      "faculty": "Dr. Patel", "weekly_periods": 3, "room_type": "classroom" },
    { "id": "CP101", "name": "C Lab", "class_id": "CS1",
      "faculty": "Dr. Patel", "weekly_periods": 1, "room_type": "lab", "duration": 2 }
  ],
  "faculty_unavailable": [
    { "faculty": "Dr. Patel", "day": "Monday", "slot": "09:00" }
  ]
}
```

The response includes `success`, `entries`, `issues`, `summary`, `stats_by_faculty`, and `stats_by_class`.

## Known limitations

- Greedy algorithm, not a complete optimisation solver — may produce suboptimal solutions for very dense schedules
- No database persistence (in-memory only); refresh resets state
- No login / role-based access
- No manual drag-and-drop timetable editing
- No lock-and-regenerate workflow
- All results must be reviewed before real-world publication

## Suggested team split (3 members)

| Member | Focus |
|---|---|
| 1 | Backend: extend the scheduler (backtracking, priority-weighted constraints) |
| 2 | Frontend: improve the timetable grid, add print/PDF export |
| 3 | Integration, edge-case testing, demo slides and documentation |

Agree on the JSON data format before working in parallel.
