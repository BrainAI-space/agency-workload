import { AlertTriangle, ArrowLeft, LockKeyhole } from "lucide-react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

export function LoadingState({ label = "Checking your session" }: { label?: string }) {
  return (
    <main className="route-state" aria-live="polite" aria-busy="true">
      <span className="loading-mark" aria-hidden="true" />
      <p className="eyebrow">Agency Workload</p>
      <h1>{label}</h1>
      <p>Preparing a secure view of your workspace.</p>
    </main>
  );
}

export function ForbiddenPage() {
  return (
    <main className="route-state">
      <LockKeyhole aria-hidden="true" />
      <p className="eyebrow">Authorization</p>
      <h1>Access restricted</h1>
      <p>This section is available to organization owners and administrators.</p>
      <Link className="text-link" to="/schedule">
        <ArrowLeft aria-hidden="true" /> Return to schedule
      </Link>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="route-state">
      <p className="eyebrow">404 / Off the board</p>
      <h1>Page not found</h1>
      <p>The route does not belong to this edition of Agency Workload.</p>
      <Link className="text-link" to="/schedule">
        <ArrowLeft aria-hidden="true" /> Return to schedule
      </Link>
    </main>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main className="route-state" role="alert">
      <AlertTriangle aria-hidden="true" />
      <p className="eyebrow">Error {status}</p>
      <h1>We could not open this view</h1>
      <p>Nothing was changed. Return to the schedule and try again.</p>
      <Link className="text-link" to="/schedule">
        <ArrowLeft aria-hidden="true" /> Return to schedule
      </Link>
    </main>
  );
}
