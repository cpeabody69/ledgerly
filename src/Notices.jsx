import { useEffect, useState } from "react";

async function readJson(response) {
  return response.json().catch(() => ({}));
}

export function TaskNotices({ open, onToggle, onOpenQueue }) {
  const [notices, setNotices] = useState([]);

  function load() {
    return fetch("/api/notices").then(async (response) => {
      const body = await readJson(response);
      if (response.ok) setNotices(body.notices || []);
    }).catch(() => {});
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open]);

  async function markRead(notice) {
    const response = await fetch(`/api/notices/${notice.id}/read`, { method: "POST" });
    const body = await readJson(response);
    if (response.ok) setNotices(body.notices || []);
  }

  const unread = notices.some((notice) => !notice.readAt);

  return (
    <div className="top-menu-wrap">
      <button className={`notification ${open ? "active" : ""}`} type="button" aria-label="Notifications" onClick={onToggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {unread ? <i /> : null}
      </button>
      {open ? (
        <div className="top-menu notification-menu">
          <div className="menu-title"><b>Notifications</b></div>
          {notices.length ? notices.map((notice) => (
            <div className={`notice-row ${notice.readAt ? "read" : ""}`} key={notice.id}>
              <button type="button" onClick={onOpenQueue}>
                <span className={`notice-dot ${notice.kind === "overdue" ? "red" : notice.kind === "completed" ? "blue" : "amber"}`} />
                <span><b>{notice.title}</b><small>{notice.createdAtLabel}{notice.readAt ? " · Read" : ""}</small></span>
              </button>
              {notice.readAt ? null : <button className="notice-read" type="button" onClick={() => markRead(notice)}>Mark read</button>}
            </div>
          )) : <p className="books-note">No task notices.</p>}
        </div>
      ) : null}
    </div>
  );
}
