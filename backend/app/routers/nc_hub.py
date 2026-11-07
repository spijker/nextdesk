"""Nextcloud desktop integrations — avatar, notifications, notes, calendar.
Best-effort: each endpoint returns empty / 404 rather than erroring if the NC
app isn't installed, so the frontend widgets just hide."""
import re
import urllib.parse
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.services import nextcloud as nc_svc

router = APIRouter(prefix="/api/nextcloud", tags=["nextcloud"])
TIMEOUT = 15


async def _creds(user: User, db: AsyncSession) -> tuple[str, str, str]:
    c = await nc_svc.get_user_creds(db, user)
    if not c:
        raise HTTPException(422, "Nextcloud not configured")
    return c


def _avatar_response(r: httpx.Response) -> Response:
    return Response(content=r.content,
                    media_type=r.headers.get("content-type", "image/png"),
                    headers={"Cache-Control": "private, max-age=3600"})


@router.get("/avatar")
async def avatar(size: int = 64, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    px = min(max(size, 16), 512)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        creds = await nc_svc.get_user_creds(db, user)
        if creds:
            nc_url, nc_user, pw = creds
            url = f"{nc_url}/index.php/avatar/{urllib.parse.quote(nc_user, safe='')}/{px}"
            r = await c.get(url, auth=(nc_user, pw))
            if r.status_code == 200:
                return _avatar_response(r)
        # No NC creds (or NC has no avatar): fall back to the URL from the
        # OIDC `picture` claim captured at login.
        pic = (user.preferences or {}).get("avatar_url")
        if pic:
            # NC picture claims end in a pixel size — swap in the requested one.
            r = await c.get(re.sub(r"/\d+$", f"/{px}", pic), follow_redirects=True)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"):
                return _avatar_response(r)
    raise HTTPException(404, "No avatar")


@router.get("/notifications")
async def notifications(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    url = f"{nc_url}/ocs/v2.php/apps/notifications/api/v2/notifications?format=json"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(url, headers={"OCS-APIRequest": "true", "Accept": "application/json"}, auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    return [{
        "id": n.get("notification_id"),
        "app": n.get("app"),
        "subject": n.get("subject"),
        "message": n.get("message", ""),
        "at": n.get("datetime"),
        "link": n.get("link", ""),
    } for n in (data or [])]


@router.delete("/notifications")
async def clear_notifications(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        await c.delete(f"{nc_url}/ocs/v2.php/apps/notifications/api/v2/notifications",
                       headers={"OCS-APIRequest": "true"}, auth=(nc_user, pw))
    return {"ok": True}


@router.delete("/notifications/{notif_id}")
async def dismiss_notification(notif_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        await c.delete(f"{nc_url}/ocs/v2.php/apps/notifications/api/v2/notifications/{notif_id}",
                       headers={"OCS-APIRequest": "true"}, auth=(nc_user, pw))
    return {"ok": True}


@router.get("/notes")
async def notes(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    url = f"{nc_url}/index.php/apps/notes/api/v1/notes"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(url, headers={"Accept": "application/json"}, auth=(nc_user, pw))
        data = r.json() if r.status_code == 200 else []
    except Exception:
        return []
    out = [{
        "id": n.get("id"),
        "title": n.get("title") or "Untitled",
        "category": n.get("category", ""),
        "modified": n.get("modified"),
        "content": n.get("content", "") or "",
    } for n in (data or [])]
    out.sort(key=lambda n: n.get("modified") or 0, reverse=True)
    return out[:50]


@router.post("/notes")
async def create_note(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    payload = {"content": body.get("content", ""), "category": body.get("category", "")}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{nc_url}/index.php/apps/notes/api/v1/notes",
                         json=payload, headers={"Accept": "application/json"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Notes app not available")
    return r.json()


@router.put("/notes/{note_id}")
async def update_note(note_id: int, body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    payload = {"content": body.get("content", "")}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(f"{nc_url}/index.php/apps/notes/api/v1/notes/{note_id}",
                        json=payload, headers={"Accept": "application/json"}, auth=(nc_user, pw))
    if r.status_code != 200:
        raise HTTPException(502, "Save failed")
    return r.json()


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        await c.delete(f"{nc_url}/index.php/apps/notes/api/v1/notes/{note_id}",
                       headers={"Accept": "application/json"}, auth=(nc_user, pw))
    return {"ok": True}


def _parse_ical_dt(s: str) -> str | None:
    s = s.strip()
    try:
        if "T" in s:
            return datetime.strptime(s.replace("Z", ""), "%Y%m%dT%H%M%S").isoformat()
        return datetime.strptime(s, "%Y%m%d").date().isoformat()
    except ValueError:
        return None


@router.get("/calendar")
async def calendar(month: str | None = None, days: int = 45,
                   user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Events for a month (month=YYYY-MM) or a rolling window, plus the writable
    calendar list so the client can create events."""
    nc_url, nc_user, pw = await _creds(user, db)
    cal_home = f"{nc_url}/remote.php/dav/calendars/{urllib.parse.quote(nc_user, safe='')}/"
    if month:
        try:
            y, m = (int(x) for x in month.split("-"))
            first = datetime(y, m, 1, tzinfo=UTC)
            nxt = datetime(y + (m == 12), (m % 12) + 1, 1, tzinfo=UTC)
            win_start, win_end = first - timedelta(days=7), nxt + timedelta(days=7)
        except ValueError:
            win_start, win_end = datetime.now(UTC), datetime.now(UTC) + timedelta(days=days)
    else:
        win_start = datetime.now(UTC) - timedelta(days=1)
        win_end = datetime.now(UTC) + timedelta(days=days)
    start, end = win_start.strftime("%Y%m%dT%H%M%SZ"), win_end.strftime("%Y%m%dT%H%M%SZ")

    propfind = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
                'xmlns:x="http://apple.com/ns/ical/"><d:prop>'
                '<d:resourcetype/><d:displayname/><x:calendar-color/></d:prop></d:propfind>')
    report = ('<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" '
              'xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>'
              '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
              f'<c:time-range start="{start}" end="{end}"/></c:comp-filter></c:comp-filter>'
              '</c:filter></c:calendar-query>')
    calendars: list[dict] = []
    events: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            pf = await c.request("PROPFIND", cal_home, headers={"Depth": "1"}, auth=(nc_user, pw), content=propfind)
            for resp in re.findall(r"<d:response>(.*?)</d:response>", pf.text, re.S):
                if "calendar" not in resp:
                    continue
                href = re.search(r"<d:href>(.*?)</d:href>", resp)
                name_m = re.search(r"<d:displayname>(.*?)</d:displayname>", resp)
                if not href or not name_m or not name_m.group(1).strip():
                    continue
                cal_name = name_m.group(1).strip()
                color_m = re.search(r"calendar-color[^>]*>(#?[0-9A-Fa-f]{3,8})", resp)
                color = (color_m.group(1)[:7] if color_m else "#6366f1")
                calendars.append({"name": cal_name, "color": color, "href": href.group(1)})

                cu = nc_url + href.group(1) if href.group(1).startswith("/") else href.group(1)
                rep = await c.request("REPORT", cu, headers={"Depth": "1", "Content-Type": "application/xml"},
                                      auth=(nc_user, pw), content=report)
                text = rep.text.replace("\r\n ", "").replace("\n ", "")
                for rblock in re.findall(r"<d:response>(.*?)</d:response>", text, re.S):
                    ehref = re.search(r"<d:href>(.*?)</d:href>", rblock)
                    vevent = re.search(r"BEGIN:VEVENT(.*?)END:VEVENT", rblock, re.S)
                    if not ehref or not vevent:
                        continue
                    block = vevent.group(1)
                    summ = re.search(r"[\r\n]SUMMARY[^:\r\n]*:(.*)", block)
                    dt = re.search(r"[\r\n]DTSTART[^:\r\n]*:(.*)", block)
                    uid_m = re.search(r"[\r\n]UID[^:\r\n]*:(.*)", block)
                    if summ and dt:
                        when = _parse_ical_dt(dt.group(1))
                        if when:
                            events.append({
                                "summary": summ.group(1).strip(), "start": when,
                                "all_day": "T" not in dt.group(1),
                                "calendar": cal_name, "color": color,
                                "href": ehref.group(1).strip(),
                                "uid": uid_m.group(1).strip() if uid_m else "",
                            })
    except Exception:
        return {"calendars": [], "events": []}
    events.sort(key=lambda e: e["start"])
    return {"calendars": calendars, "events": events}


def _ics(uid: str, summary: str, start: str, end: str, all_day: bool) -> str:
    now = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    if all_day:
        ds, de = f"DTSTART;VALUE=DATE:{start}", f"DTEND;VALUE=DATE:{end}"
    else:
        ds, de = f"DTSTART:{start}", f"DTEND:{end}"
    summary = summary.replace("\n", " ").replace(",", "\\,").replace(";", "\\;")
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//LWP//NC Hub//EN\r\n"
            f"BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{now}\r\n{ds}\r\n{de}\r\n"
            f"SUMMARY:{summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


@router.post("/calendar/event")
async def create_event(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Create a VEVENT. body: {calendar_href, summary, all_day, start, end}
    (start/end are YYYYMMDD for all-day, else YYYYMMDDTHHMMSS floating)."""
    nc_url, nc_user, pw = await _creds(user, db)
    cal_href = body.get("calendar_href", "")
    if not cal_href:
        raise HTTPException(400, "calendar_href required")
    uid = str(uuid.uuid4())
    ics = _ics(uid, body.get("summary", "Untitled"), body["start"], body["end"], bool(body.get("all_day")))
    url = (nc_url + cal_href if cal_href.startswith("/") else cal_href).rstrip("/") + f"/{uid}.ics"
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(url, content=ics, headers={"Content-Type": "text/calendar; charset=utf-8"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201, 204):
        raise HTTPException(502, f"Create failed ({r.status_code})")
    return {"ok": True, "uid": uid}


@router.delete("/talk/{token}")
async def talk_delete_room(token: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Delete a Talk conversation room."""
    nc_url, nc_user, pw = await _creds(user, db)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.delete(f"{nc_url}{_TALK}/v4/room/{urllib.parse.quote(token)}", headers=_OCS, auth=(nc_user, pw))
    if r.status_code not in (200, 201, 202):
        raise HTTPException(502, "Delete failed")
    return {"ok": True}


@router.delete("/calendar/event")
async def delete_event(href: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    url = nc_url + href if href.startswith("/") else href
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        await c.delete(url, auth=(nc_user, pw))
    return {"ok": True}


# ── Tasks (CalDAV VTODO) ────────────────────────────────────────────────────────

def _vtodo(uid: str, summary: str, completed: bool) -> str:
    now = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    summary = summary.replace("\n", " ").replace(",", "\\,").replace(";", "\\;")
    status = ("STATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\n" f"COMPLETED:{now}\r\n") if completed else "STATUS:NEEDS-ACTION\r\n"
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//LWP//NC Hub//EN\r\n"
            f"BEGIN:VTODO\r\nUID:{uid}\r\nDTSTAMP:{now}\r\nSUMMARY:{summary}\r\n{status}"
            "END:VTODO\r\nEND:VCALENDAR\r\n")


@router.get("/tasks")
async def tasks(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    cal_home = f"{nc_url}/remote.php/dav/calendars/{urllib.parse.quote(nc_user, safe='')}/"
    propfind = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:x="http://apple.com/ns/ical/">'
                '<d:prop><d:resourcetype/><d:displayname/><x:calendar-color/></d:prop></d:propfind>')
    report = ('<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
              '<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR">'
              '<c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>')
    lists: list[dict] = []
    todos: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            pf = await c.request("PROPFIND", cal_home, headers={"Depth": "1"}, auth=(nc_user, pw), content=propfind)
            for resp in re.findall(r"<d:response>(.*?)</d:response>", pf.text, re.S):
                if "calendar" not in resp:
                    continue
                href = re.search(r"<d:href>(.*?)</d:href>", resp)
                name_m = re.search(r"<d:displayname>(.*?)</d:displayname>", resp)
                if not href or not name_m or not name_m.group(1).strip():
                    continue
                name = name_m.group(1).strip()
                color_m = re.search(r"calendar-color[^>]*>(#?[0-9A-Fa-f]{3,8})", resp)
                color = (color_m.group(1)[:7] if color_m else "#6366f1")
                cu = nc_url + href.group(1) if href.group(1).startswith("/") else href.group(1)
                rep = await c.request("REPORT", cu, headers={"Depth": "1", "Content-Type": "application/xml"},
                                      auth=(nc_user, pw), content=report)
                text = rep.text.replace("\r\n ", "").replace("\n ", "")
                found = False
                for rb in re.findall(r"<d:response>(.*?)</d:response>", text, re.S):
                    eh = re.search(r"<d:href>(.*?)</d:href>", rb)
                    vt = re.search(r"BEGIN:VTODO(.*?)END:VTODO", rb, re.S)
                    if not eh or not vt:
                        continue
                    block = vt.group(1)
                    summ = re.search(r"[\r\n]SUMMARY[^:\r\n]*:(.*)", block)
                    uid_m = re.search(r"[\r\n]UID[^:\r\n]*:(.*)", block)
                    status = re.search(r"[\r\n]STATUS[^:\r\n]*:(.*)", block)
                    if summ:
                        found = True
                        todos.append({
                            "summary": summ.group(1).strip(),
                            "completed": bool(status and "COMPLETED" in status.group(1)),
                            "href": eh.group(1).strip(), "uid": uid_m.group(1).strip() if uid_m else "",
                            "list": name, "color": color,
                        })
                if found or True:  # a VTODO-capable list; expose for creation
                    lists.append({"name": name, "color": color, "href": href.group(1)})
    except Exception:
        return {"lists": [], "tasks": []}
    todos.sort(key=lambda t: (t["completed"], t["summary"].lower()))
    return {"lists": lists, "tasks": todos}


@router.post("/tasks")
async def create_task(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    cal_href = body.get("list_href", "")
    if not cal_href:
        raise HTTPException(400, "list_href required")
    uid = str(uuid.uuid4())
    ics = _vtodo(uid, body.get("summary", "Untitled"), False)
    url = (nc_url + cal_href if cal_href.startswith("/") else cal_href).rstrip("/") + f"/{uid}.ics"
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(url, content=ics, headers={"Content-Type": "text/calendar; charset=utf-8"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201, 204):
        raise HTTPException(502, f"Create failed ({r.status_code})")
    return {"ok": True}


@router.patch("/tasks")
async def toggle_task(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Toggle completion (rebuilds the VTODO). body: {href, uid, summary, completed}."""
    nc_url, nc_user, pw = await _creds(user, db)
    href = body["href"]
    url = nc_url + href if href.startswith("/") else href
    ics = _vtodo(body.get("uid") or str(uuid.uuid4()), body.get("summary", "Untitled"), bool(body.get("completed")))
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(url, content=ics, headers={"Content-Type": "text/calendar; charset=utf-8"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201, 204):
        raise HTTPException(502, f"Update failed ({r.status_code})")
    return {"ok": True}


@router.delete("/tasks")
async def delete_task(href: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    url = nc_url + href if href.startswith("/") else href
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        await c.delete(url, auth=(nc_user, pw))
    return {"ok": True}


# ── Deck (kanban) ───────────────────────────────────────────────────────────────

_DECK = "/index.php/apps/deck/api/v1.0"


def _color(c: str | None) -> str:
    c = (c or "").lstrip("#")
    return "#" + c if len(c) in (3, 6) else "#6366f1"


@router.get("/deck")
async def deck_boards(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_DECK}/boards", headers={"OCS-APIRequest": "true", "Accept": "application/json"}, auth=(nc_user, pw))
        data = r.json() if r.status_code == 200 else []
    except Exception:
        return []
    return [{"id": b.get("id"), "title": b.get("title"), "color": _color(b.get("color"))}
            for b in (data or []) if not b.get("archived") and not b.get("deletedAt")]


@router.get("/deck/{board_id}")
async def deck_board(board_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_DECK}/boards/{board_id}/stacks", headers={"OCS-APIRequest": "true", "Accept": "application/json"}, auth=(nc_user, pw))
        data = r.json() if r.status_code == 200 else []
    except Exception:
        return []
    stacks = []
    for s in (data or []):
        cards = [{"id": cd.get("id"), "title": cd.get("title"), "done": bool(cd.get("done"))}
                 for cd in (s.get("cards") or []) if not cd.get("archived")]
        stacks.append({"id": s.get("id"), "title": s.get("title"), "cards": cards})
    return stacks


@router.post("/deck/card")
async def deck_create_card(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    bid, sid = body.get("board_id"), body.get("stack_id")
    if not bid or not sid:
        raise HTTPException(400, "board_id and stack_id required")
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{nc_url}{_DECK}/boards/{bid}/stacks/{sid}/cards",
                         json={"title": body.get("title", "Untitled"), "type": "plain", "order": 999},
                         headers={"OCS-APIRequest": "true", "Accept": "application/json"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Create failed")
    return {"ok": True}


@router.post("/deck/card/archive")
async def deck_archive_card(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Archive (mark done) a card. body: {board_id, stack_id, card_id}."""
    nc_url, nc_user, pw = await _creds(user, db)
    bid, sid, cid = body.get("board_id"), body.get("stack_id"), body.get("card_id")
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(f"{nc_url}{_DECK}/boards/{bid}/stacks/{sid}/cards/{cid}/archive",
                        json={}, headers={"OCS-APIRequest": "true", "Accept": "application/json"}, auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Archive failed")
    return {"ok": True}


# ── Passwords ───────────────────────────────────────────────────────────────

_PASSWORD = "/ocs/v2.php/apps/passwords/api/1.0"


def _passwords_headers(key: str | None = None) -> dict:
    """Build headers for Passwords API. Optionally includes encryption key."""
    headers = {"OCS-APIRequest": "true", "Accept": "application/json"}
    if key:
        headers["X-Passwords-Key"] = key
    return headers


@router.get("/passwords/status")
async def passwords_status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Check if Nextcloud Passwords has a master password set.
    
    Returns: {has_master_password: bool, key_required: bool}
    
    The Nextcloud Passwords API will return 403 Forbidden when trying to access
    passwords without the correct encryption key. We test this by trying to
    fetch the password list without a key.
    """
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            # Try to fetch passwords without a key - if we get 403, master password is set
            r = await c.get(f"{nc_url}{_PASSWORD}/passwords",
                          headers=_passwords_headers(),
                          auth=(nc_user, pw))
        # If we get 200, no master password or it's already unlocked
        if r.status_code == 200:
            return {"has_master_password": False, "key_required": False}
        # If we get 403, master password is required
        elif r.status_code == 403:
            return {"has_master_password": True, "key_required": True}
        # Any other status - assume no master password but there might be an error
        return {"has_master_password": False, "key_required": False}
    except Exception as e:
        # If we get an exception, check if it's a 403
        if hasattr(e, 'response') and getattr(e.response, 'status_code', None) == 403:
            return {"has_master_password": True, "key_required": True}
        return {"has_master_password": False, "key_required": False}


@router.get("/passwords")
async def passwords(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session), key: str | None = None):
    """List all password entries for the user.
    
    Args:
        key: Optional encryption key (required if master password is set in Nextcloud Passwords)
    """
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_PASSWORD}/passwords",
                          headers=_passwords_headers(key),
                          auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    return [{
        "id": p.get("id"),
        "label": p.get("label"),
        "username": p.get("username"),
        "url": p.get("url"),
        "folder_id": p.get("folder_id"),
        "favicon": p.get("favicon"),
        "updated": p.get("updated"),
    } for p in (data or [])]


@router.get("/passwords/{password_id}")
async def password_detail(password_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session), key: str | None = None):
    """Get a specific password entry (decrypted by the Passwords app).
    
    Args:
        password_id: The password ID
        key: Optional encryption key (required if master password is set in Nextcloud Passwords)
    """
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_PASSWORD}/passwords/{password_id}",
                          headers=_passwords_headers(key),
                          auth=(nc_user, pw))
        return r.json().get("ocs", {}).get("data", {}) if r.status_code == 200 else {}
    except Exception:
        return {}


@router.post("/passwords")
async def create_password(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Create a new password entry. body: {label, username, password, url, folder_id, notes, key, ...}"""
    nc_url, nc_user, pw = await _creds(user, db)
    key = body.pop("key", None)  # Extract encryption key if provided
    payload = {
        "label": body.get("label", ""),
        "username": body.get("username", ""),
        "password": body.get("password", ""),
        "url": body.get("url", ""),
        "folder_id": body.get("folder_id"),
        "notes": body.get("notes", ""),
        "favicon": body.get("favicon"),
        "expire_time": body.get("expire_time"),
        "hide_password": bool(body.get("hide_password", False)),
        "custom_fields": body.get("custom_fields", []),
    }
    # Filter out None values
    payload = {k: v for k, v in payload.items() if v is not None}
    
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{nc_url}{_PASSWORD}/passwords",
                         json=payload,
                         headers=_passwords_headers(key),
                         auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Create failed")
    return r.json().get("ocs", {}).get("data", {})


@router.put("/passwords/{password_id}")
async def update_password(password_id: int, body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Update an existing password entry."""
    nc_url, nc_user, pw = await _creds(user, db)
    key = body.pop("key", None)  # Extract encryption key if provided
    payload = {
        "label": body.get("label"),
        "username": body.get("username"),
        "password": body.get("password"),
        "url": body.get("url"),
        "folder_id": body.get("folder_id"),
        "notes": body.get("notes"),
        "favicon": body.get("favicon"),
        "expire_time": body.get("expire_time"),
        "hide_password": body.get("hide_password"),
        "custom_fields": body.get("custom_fields"),
    }
    # Filter out None values
    payload = {k: v for k, v in payload.items() if v is not None}
    
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.put(f"{nc_url}{_PASSWORD}/passwords/{password_id}",
                        json=payload,
                        headers=_passwords_headers(key),
                        auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Update failed")
    return r.json().get("ocs", {}).get("data", {})


@router.delete("/passwords/{password_id}")
async def delete_password(password_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session), key: str | None = None):
    """Delete a password entry."""
    nc_url, nc_user, pw = await _creds(user, db)
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.delete(f"{nc_url}{_PASSWORD}/passwords/{password_id}",
                           headers=_passwords_headers(key),
                           auth=(nc_user, pw))
    if r.status_code not in (200, 201, 204):
        raise HTTPException(502, "Delete failed")
    return {"ok": True}


@router.get("/passwords/folders")
async def password_folders(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session), key: str | None = None):
    """List all password folders/tags."""
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_PASSWORD}/folders",
                          headers=_passwords_headers(key),
                          auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    return [{"id": f.get("id"), "label": f.get("label"), "color": f.get("color")}
            for f in (data or [])]


@router.post("/passwords/generate")
async def generate_password(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Generate a random password using Nextcloud Passwords' generator.
    body: {length, use_upper, use_lower, use_numbers, use_special, exclude_special_chars}
    
    Note: Password generation doesn't require the encryption key."""
    nc_url, nc_user, pw = await _creds(user, db)
    payload = {
        "length": body.get("length", 16),
        "use_upper": bool(body.get("use_upper", True)),
        "use_lower": bool(body.get("use_lower", True)),
        "use_numbers": bool(body.get("use_numbers", True)),
        "use_special": bool(body.get("use_special", False)),
        "exclude_special_chars": body.get("exclude_special_chars", ""),
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.post(f"{nc_url}{_PASSWORD}/password/generate",
                            json=payload,
                            headers=_passwords_headers(),
                            auth=(nc_user, pw))
        return r.json().get("ocs", {}).get("data", {}) if r.status_code == 200 else {}
    except Exception:
        return {}


# ── Talk (chat only — not the spreed video calls) ───────────────────────────────

_TALK = "/ocs/v2.php/apps/spreed/api"
_OCS = {"OCS-APIRequest": "true", "Accept": "application/json"}


@router.get("/talk")
async def talk_rooms(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_TALK}/v4/room", headers=_OCS, auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    rooms = [{
        "token": rm.get("token"), "name": rm.get("displayName"),
        "unread": rm.get("unreadMessages", 0),
        "last": (rm.get("lastMessage") or {}).get("message", ""),
        "last_at": (rm.get("lastMessage") or {}).get("timestamp", 0),
    } for rm in (data or []) if rm.get("type") != 4]  # skip changelog room
    rooms.sort(key=lambda r: r["last_at"], reverse=True)
    return rooms


@router.get("/talk/{token}")
async def talk_messages(token: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}{_TALK}/v1/chat/{urllib.parse.quote(token)}",
                            params={"lookIntoFuture": 0, "limit": 50, "setReadMarker": 1},
                            headers=_OCS, auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    msgs = [{
        "id": m.get("id"), "actor": m.get("actorDisplayName"),
        "message": m.get("message", ""), "at": m.get("timestamp", 0),
        "mine": m.get("actorId") == nc_user,
        "system": m.get("systemMessage", "") != "",
    } for m in (data or []) if m.get("messageType") != "command"]
    msgs.sort(key=lambda m: m["id"])  # oldest -> newest
    return msgs


@router.post("/talk/{token}")
async def talk_send(token: str, body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    nc_url, nc_user, pw = await _creds(user, db)
    msg = (body.get("message") or "").strip()
    if not msg:
        raise HTTPException(400, "empty message")
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{nc_url}{_TALK}/v1/chat/{urllib.parse.quote(token)}",
                         json={"message": msg}, headers=_OCS, auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Send failed")
    return {"ok": True}


@router.get("/talk/contacts/search")
async def talk_search_contacts(q: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Search NC users to start a new 1:1 Talk chat with (same autocomplete
    the Talk web UI uses for 'New conversation')."""
    q = q.strip()
    if len(q) < 2:
        return []
    nc_url, nc_user, pw = await _creds(user, db)
    params = [("search", q), ("itemType", "call"), ("itemId", "new"), ("shareTypes[]", "0")]
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            r = await c.get(f"{nc_url}/ocs/v2.php/core/autocomplete/get", params=params, headers=_OCS, auth=(nc_user, pw))
        data = r.json().get("ocs", {}).get("data", []) if r.status_code == 200 else []
    except Exception:
        return []
    return [{"id": p.get("id"), "label": p.get("label")} for p in (data or [])
            if p.get("source") == "users" and p.get("id") != nc_user]


@router.post("/talk/contacts/start")
async def talk_start_chat(body: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_session)):
    """Open (or create) the 1:1 room with the given NC user id and return it
    like a /talk list entry so the frontend can jump straight into it."""
    nc_url, nc_user, pw = await _creds(user, db)
    invite = (body.get("user_id") or "").strip()
    if not invite:
        raise HTTPException(400, "user_id required")
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{nc_url}{_TALK}/v4/room", json={"roomType": 1, "invite": invite}, headers=_OCS, auth=(nc_user, pw))
    if r.status_code not in (200, 201):
        raise HTTPException(502, "Could not start chat")
    rm = r.json().get("ocs", {}).get("data", {})
    return {
        "token": rm.get("token"), "name": rm.get("displayName"),
        "unread": rm.get("unreadMessages", 0),
        "last": (rm.get("lastMessage") or {}).get("message", ""),
        "last_at": (rm.get("lastMessage") or {}).get("timestamp", 0),
    }
