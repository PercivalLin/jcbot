import { useEffect, useState } from "react";

export type RouteMatch =
  | { name: "setup" }
  | { name: "runtime" }
  | { name: "config" }
  | { name: "run-detail"; runId: string };

function parseRoute(pathname: string): RouteMatch {
  if (pathname === "/" || pathname === "/setup") {
    return { name: "setup" };
  }
  if (pathname === "/runtime") {
    return { name: "runtime" };
  }
  if (pathname === "/config") {
    return { name: "config" };
  }
  const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    return { name: "run-detail", runId: decodeURIComponent(runMatch[1]) };
  }
  return { name: "runtime" };
}

export function navigate(pathname: string) {
  if (window.location.pathname === pathname) {
    return;
  }
  window.history.pushState({}, "", pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): RouteMatch {
  const [route, setRoute] = useState<RouteMatch>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return route;
}
