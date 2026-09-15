import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Keep the product site public; the operational console requires an account.
const isConsoleRoute = createRouteMatcher(["/app(.*)"]);
// Onboarding (W4) is signed-in only too (Clerk sends visitors to sign-in and back).
const isOnboardingRoute = createRouteMatcher(["/onboarding(.*)"]);

// Set client-side by components/onboarding/OnboardingGate after GET /api/me: "pending" when the
// org or first project is missing. Cheap optimistic check — the gate stays the source of truth,
// and a stale cookie self-heals because /onboarding re-checks /api/me and routes back to /app.
const ONBOARDING_COOKIE = "vesper_onb";

const isDevPreview = createRouteMatcher(["/onboarding/preview(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (process.env.NODE_ENV !== "production" && isDevPreview(request)) return;
  // Dev-only: the `vesper_dev_preview=1` cookie opens /app signed-out against a local-auth backend,
  // so the dashboard can be checked in an automated browser. Never active in production builds.
  if (process.env.NODE_ENV !== "production" && request.cookies.get("vesper_dev_preview")?.value === "1") return;
  if (!isOnboardingRoute(request) && !isConsoleRoute(request)) return;

  // The Clerk instance forces organization selection, so a new user's session is "pending" until
  // they have an org. auth.protect() treats pending as signed out and bounces to Clerk's hosted
  // task page; Vesper runs that step itself at /onboarding/org, so accept pending sessions here.
  const session = await auth({ treatPendingAsSignedOut: false });
  if (!session.userId) return session.redirectToSignIn({ returnBackUrl: request.url });

  if (isOnboardingRoute(request)) return;

  if (request.method === "GET") {
    if (!session.orgId) return NextResponse.redirect(new URL("/onboarding/org", request.url));
    if (request.cookies.get(ONBOARDING_COOKIE)?.value === "pending") {
      return NextResponse.redirect(new URL("/onboarding", request.url));
    }
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static assets unless a query string is present.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
