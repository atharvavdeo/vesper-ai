// Static demo build only (STATIC_DEMO=1): stands in for @clerk/nextjs so the exported /demo
// needs no Clerk keys, no auth backend and makes no network calls. Never used by the real app.
import type { ReactNode } from "react";

export const useAuth = () => ({ getToken: async () => null, userId: null as string | null, isSignedIn: false });
export const useUser = () => ({ user: null, isLoaded: true, isSignedIn: false });
export const UserButton = () => null;
export const SignIn = () => null;
export const SignUp = () => null;
export const ClerkProvider = ({ children }: { children: ReactNode }) => children;
