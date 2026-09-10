import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Keep the product site public; the operational console requires an account.
const isConsoleRoute = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (isConsoleRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static assets unless a query string is present.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
