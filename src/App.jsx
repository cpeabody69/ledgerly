import { useCallback, useEffect, useState } from "react";
import { Portal } from "./Portal.jsx";
import { Te } from "./Shell.jsx";
import { ChecklistBanner, OnboardingScreen, PublicAuth } from "./AuthScreens.jsx";

const PUBLIC_PATHS = new Set(["/register", "/forgot-password", "/reset-password", "/verify-email", "/invitation"]);

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next) => {
    const url = next.startsWith("/") ? next : `/${next}`;
    window.history.pushState({}, "", url);
    setPath(window.location.pathname);
  }, []);
  return [path, go];
}

export function App() {
  const [session, setSession] = useState(undefined);
  const [path, go] = usePath();

  useEffect(() => {
    let cancel = false;
    fetch("/api/session")
      .then(async (response) => {
        if (cancel) return;
        if (!response.ok) {
          setSession(null);
          return;
        }
        setSession(await response.json());
      })
      .catch(() => {
        if (!cancel) setSession(null);
      });
    return () => {
      cancel = true;
    };
  }, []);

  if (session === undefined) return <div className="sign-in" />;
  if (PUBLIC_PATHS.has(path) || !session) {
    return <PublicAuth path={path} go={go} session={session} onSession={setSession} />;
  }
  if (session.onboarding || path === "/onboarding") {
    return <OnboardingScreen session={session} onSession={setSession} go={go} />;
  }
  if (session.portal) return <Portal session={session} onSession={setSession} />;
  return (
    <>
      <ChecklistBanner session={session} go={go} />
      <Te session={session} onSession={setSession} />
    </>
  );
}
