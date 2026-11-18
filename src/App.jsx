import { useCallback, useEffect, useState } from "react";
import { Portal } from "./Portal.jsx";
import { Te } from "./Shell.jsx";
import { ChecklistBanner, OnboardingScreen, PublicAuth } from "./AuthScreens.jsx";
import { SubscribeReturn, SubscriptionBanner } from "./Subscription.jsx";
import { Privacy } from "./Privacy.jsx";
import { Terms } from "./Terms.jsx";
import { ProductSite } from "./ProductSite.jsx";
import { DemoMode } from "./DemoMode.jsx";

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
  const [tour, setTour] = useState({ screen: "", nonce: 0 });
  const [navOpen, setNavOpen] = useState(false);

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

  if (path === "/terms") return <Terms go={go} />;
  if (path === "/privacy") return <Privacy go={go} />;
  if (session === undefined) return <div className="sign-in" />;
  if (path === "/" && !session) return <ProductSite path={path} go={go} onSession={setSession} />;
  if (path === "/pricing" || path === "/demo" || path === "/beta") return <ProductSite path={path} go={go} onSession={setSession} />;
  if (path === "/subscribe/return" && session) {
    return <SubscribeReturn session={session} onSession={setSession} go={go} />;
  }
  if (PUBLIC_PATHS.has(path) || !session) {
    return <PublicAuth path={path} go={go} session={session} onSession={setSession} />;
  }
  if (session.onboarding || path === "/onboarding") {
    return <OnboardingScreen session={session} onSession={setSession} go={go} />;
  }
  const openScreen = (screen) => setTour((current) => ({ screen, nonce: current.nonce + 1 }));
  if (session.portal) {
    const portal = <Portal session={session} onSession={setSession} />;
    if (!session.publicDemo) return portal;
    return (
      <div className="demo-app is-portal">
        <DemoMode session={session} onSession={setSession} onOpenScreen={openScreen} />
        {portal}
      </div>
    );
  }
  const shell = (
    <>
      <SubscriptionBanner session={session} go={go} />
      <ChecklistBanner session={session} go={go} />
      <Te session={session} onSession={setSession} requestedScreen={tour.screen} requestedNonce={tour.nonce} />
    </>
  );
  if (!session.publicDemo) return shell;
  return (
    <div className={`demo-app${navOpen ? " is-nav-open" : ""}`}>
      <DemoMode session={session} onSession={setSession} onOpenScreen={openScreen} onToggleNav={() => setNavOpen((open) => !open)} onRequestNav={setNavOpen} />
      {shell}
      {navOpen ? <button className="demo-nav-scrim" type="button" aria-label="Close menu" onClick={() => setNavOpen(false)} /> : null}
    </div>
  );
}
