import { useEffect, useState } from "react";

function readJson(response) {
  return response.json().catch(() => ({}));
}

export function ClientAccess() {
  const [payload, setPayload] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");

  function apply(body) {
    setPayload(body);
    const next = {};
    for (const member of body.members || []) {
      next[member.id] = { access: member.access === "selected" ? "selected" : "all", clientIds: member.clientIds || [] };
    }
    setDrafts(next);
  }

  useEffect(() => {
    let cancel = false;
    fetch("/api/client-grants")
      .then(async (response) => {
        const body = await readJson(response);
        if (cancel) return;
        if (!response.ok) {
          setError(body.error || "Could not load client access.");
          return;
        }
        setError("");
        apply(body);
      })
      .catch(() => {
        if (!cancel) setError("Could not load client access.");
      });
    return () => {
      cancel = true;
    };
  }, []);

  function draftFor(member) {
    return drafts[member.id] || { access: "all", clientIds: [] };
  }

  function update(memberId, patch) {
    setDrafts((current) => ({ ...current, [memberId]: { ...current[memberId], ...patch } }));
  }

  function toggleClient(memberId, clientId) {
    const draft = drafts[memberId] || { access: "selected", clientIds: [] };
    const has = draft.clientIds.includes(clientId);
    update(memberId, {
      access: "selected",
      clientIds: has ? draft.clientIds.filter((id) => id !== clientId) : [...draft.clientIds, clientId],
    });
  }

  async function save(member) {
    const draft = draftFor(member);
    setPending(member.id);
    setError("");
    const response = await fetch("/api/client-grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: member.id,
        access: draft.access === "selected" ? "selected" : "all",
        clientIds: draft.clientIds,
      }),
    });
    const body = await readJson(response);
    setPending("");
    if (!response.ok) {
      setError(body.error || "Could not save client access.");
      return;
    }
    apply(body);
  }

  const members = payload?.members || [];
  const clients = payload?.clients || [];
  return (
    <section className="table-card access-card">
      <header className="card-header">
        <div>
          <h2>Client access</h2>
          <p>Owners and administrators open every client. Other people open every client until you limit them to the ones you check.</p>
        </div>
      </header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Clients</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const draft = draftFor(member);
            return (
              <tr key={member.id}>
                <td><strong>{member.name}</strong><div>{member.email}</div></td>
                <td>{member.roleLabel}</td>
                <td>
                  {member.assignable ? (
                    <>
                      <select value={draft.access === "selected" ? "selected" : "all"} onChange={(event) => update(member.id, { access: event.target.value })}>
                        <option value="all">Every client</option>
                        <option value="selected">Selected clients</option>
                      </select>
                      {draft.access === "selected" ? (
                        <div className="access-clients">
                          {clients.map((client) => (
                            <label key={client.id}>
                              <input
                                type="checkbox"
                                checked={draft.clientIds.includes(client.id)}
                                onChange={() => toggleClient(member.id, client.id)}
                              />
                              {client.name}
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : <span>Every client</span>}
                </td>
                <td>
                  {member.assignable ? (
                    <button className="button secondary" type="button" disabled={pending === member.id} onClick={() => save(member)}>
                      {pending === member.id ? "Saving…" : "Save"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
