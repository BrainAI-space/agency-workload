import type { AppRole } from "@agency-workload/contracts";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  BookOpenText,
  RefreshCw,
  Send,
  ShieldCheck,
  UserRoundCog,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import { ApiError, type AuditEvent, api, type Invitation, type Member } from "../lib/api";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      last_owner_protected: "The final active owner cannot be changed or deactivated.",
      self_disable_forbidden: "You cannot deactivate your own membership.",
      self_role_change_forbidden: "You cannot change your own role.",
      invitation_resend_limited: "This invitation cannot be resent yet. Try again later.",
      invitation_expired: "This invitation has expired and cannot be resent.",
      invitation_exists: "A pending invitation already exists for that address.",
      role_assignment_forbidden: "Your role cannot assign the selected role.",
    };
    return messages[error.code] ?? fallback;
  }
  return fallback;
}

function AdminIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: string;
}) {
  return (
    <header className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{children}</p>
    </header>
  );
}

export function MembersPage() {
  const { user, csrfToken } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setMembers(await api.listMembers());
    } catch (loadError) {
      setError(errorMessage(loadError, "Could not load members."));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    void api
      .listMembers()
      .then((items) => {
        if (active) setMembers(items);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, "Could not load members."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const changeRole = async (member: Member, role: AppRole) => {
    if (!csrfToken) return;
    setError(null);
    try {
      await api.changeMemberRole(member.userId, role, csrfToken);
      await load();
    } catch (changeError) {
      setError(errorMessage(changeError, "Could not change that role."));
    }
  };
  const deactivate = async (member: Member) => {
    if (
      !csrfToken ||
      !window.confirm(`Deactivate ${member.email}? Their sessions will end immediately.`)
    )
      return;
    setError(null);
    try {
      await api.deactivateMember(member.userId, csrfToken);
      await load();
    } catch (deactivateError) {
      setError(errorMessage(deactivateError, "Could not deactivate that membership."));
    }
  };
  const allowedRoles: AppRole[] =
    user?.role === "owner"
      ? ["owner", "admin", "planner", "member", "viewer"]
      : ["planner", "member", "viewer"];

  return (
    <section aria-labelledby="members-title">
      <AdminIntro eyebrow="Access ledger" title="Members">
        Login access and organization authority. Schedulable people are managed separately.
      </AdminIntro>
      {error ? (
        <p role="alert" className="form-error">
          <AlertCircle aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="table-status">Loading members...</p>
      ) : (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={4}>No additional memberships yet.</td>
                </tr>
              ) : (
                members.map((member) => {
                  const self = member.userId === user?.id;
                  return (
                    <tr key={member.userId}>
                      <th scope="row">
                        <strong>{member.email}</strong>
                        <small>Added {formatDate(member.createdAt)}</small>
                      </th>
                      <td>
                        <label className="sr-only" htmlFor={`role-${member.userId}`}>
                          Role for {member.email}
                        </label>
                        <select
                          id={`role-${member.userId}`}
                          value={member.role}
                          disabled={self || !member.active}
                          onChange={(event) =>
                            void changeRole(member, event.target.value as AppRole)
                          }
                        >
                          {!allowedRoles.includes(member.role) ? (
                            <option value={member.role}>{member.role}</option>
                          ) : null}
                          {allowedRoles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={member.active ? "status-text good" : "status-text bad"}>
                          {member.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <button
                          className="danger-button"
                          type="button"
                          disabled={self || !member.active}
                          onClick={() => void deactivate(member)}
                          aria-label={`Deactivate ${member.email}`}
                        >
                          <Ban aria-hidden="true" />
                          Deactivate
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function InvitationsPage() {
  const { user, csrfToken } = useAuth();
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setInvitations(await api.listInvitations());
    } catch (loadError) {
      setError(errorMessage(loadError, "Could not load invitations."));
    }
  };
  useEffect(() => {
    let active = true;
    void api
      .listInvitations()
      .then((items) => {
        if (active) setInvitations(items);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, "Could not load invitations."));
      });
    return () => {
      active = false;
    };
  }, []);
  const roles: AppRole[] =
    user?.role === "owner"
      ? ["owner", "admin", "planner", "member", "viewer"]
      : ["planner", "member", "viewer"];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    setBusy(true);
    setError(null);
    try {
      await api.createInvitation(email, role, csrfToken);
      setEmail("");
      setRole("viewer");
      await load();
    } catch (inviteError) {
      setError(errorMessage(inviteError, "Could not create that invitation."));
    } finally {
      setBusy(false);
    }
  };
  const resend = async (invitation: Invitation) => {
    if (!csrfToken) return;
    setBusy(true);
    setError(null);
    try {
      await api.resendInvitation(invitation.id, csrfToken);
      await load();
    } catch (resendError) {
      setError(errorMessage(resendError, "Could not resend that invitation."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="invitations-title">
      <AdminIntro eyebrow="Email access" title="Invitations">
        Invite a login account by email. This does not add a person to the planning board.
      </AdminIntro>
      <form className="invite-form" onSubmit={submit}>
        <label htmlFor="invite-email">Invite email</label>
        <input
          id="invite-email"
          type="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="invite-role">Invited role</label>
        <select
          id="invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value as AppRole)}
        >
          {roles.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
        <button className="primary-button" type="submit" disabled={busy}>
          <Send aria-hidden="true" />
          Send invitation
        </button>
      </form>
      {error ? (
        <p role="alert" className="form-error">
          <AlertCircle aria-hidden="true" />
          {error}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Recipient</th>
              <th scope="col">Role</th>
              <th scope="col">Delivery</th>
              <th scope="col">Expires</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {invitations.length === 0 ? (
              <tr>
                <td colSpan={5}>No invitations yet.</td>
              </tr>
            ) : (
              invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <th scope="row">{invitation.email}</th>
                  <td>{invitation.role}</td>
                  <td>
                    <DeliveryStatus value={invitation.deliveryStatus} />
                  </td>
                  <td>{formatDate(invitation.expiresAt)}</td>
                  <td>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={busy || invitation.status !== "pending"}
                      onClick={() => void resend(invitation)}
                      aria-label={`Resend invitation to ${invitation.email}`}
                    >
                      <RefreshCw aria-hidden="true" />
                      Resend
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeliveryStatus({ value }: { value: Invitation["deliveryStatus"] }) {
  const labels = { pending: "Delivery pending", sent: "Delivered", failed: "Delivery failed" };
  return (
    <span
      className={`status-text ${value === "sent" ? "good" : value === "failed" ? "bad" : "waiting"}`}
    >
      {labels[value]}
    </span>
  );
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api
      .listAudit()
      .then(setEvents)
      .catch((loadError) => setError(errorMessage(loadError, "Could not load audit records.")));
  }, []);
  return (
    <section aria-labelledby="audit-title">
      <AdminIntro eyebrow="Append-only record" title="Audit">
        Security and administration changes recorded by the server. Details are intentionally
        concise.
      </AdminIntro>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={4}>No audit events available.</td>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.createdAt)}</td>
                  <td className="mono-cell">{shortId(event.actorUserId)}</td>
                  <td>{event.action}</td>
                  <td>
                    {event.targetType} / {shortId(event.targetId)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AdminSettingsPage() {
  return (
    <section aria-labelledby="settings-title">
      <AdminIntro eyebrow="V1 operating boundary" title="Settings">
        Agency Workload currently exposes identity, membership, invitation, session, and audit
        controls.
      </AdminIntro>
      <div className="boundary-grid">
        <article>
          <ShieldCheck aria-hidden="true" />
          <h3>Server authority</h3>
          <p>
            Fastify remains authoritative for every role and object decision. UI visibility is not
            authorization.
          </p>
        </article>
        <article>
          <UserRoundCog aria-hidden="true" />
          <h3>One organization</h3>
          <p>
            V1 allows one active membership per user. Multi-organization switching is not available.
          </p>
        </article>
        <article>
          <BookOpenText aria-hidden="true" />
          <h3>Planning next</h3>
          <p>
            Capacity, allocations, forecasts, and schedulable people are the next domain milestone.
          </p>
        </article>
      </div>
      <nav className="settings-links" aria-label="Administration shortcuts">
        <Link to="/admin/members">
          Review members <ArrowRight aria-hidden="true" />
        </Link>
        <Link to="/admin/invitations">
          Manage invitations <ArrowRight aria-hidden="true" />
        </Link>
        <Link to="/admin/audit">
          Read audit history <ArrowRight aria-hidden="true" />
        </Link>
      </nav>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function shortId(value: string | null): string {
  return value ? `${value.slice(0, 8)}…` : "System";
}
