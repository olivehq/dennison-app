import { inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "@/server/auth/auth";

export const authClient = createAuthClient({
  // The sign-in form reads `twoFactorRedirect` from the response and shows the code step itself.
  plugins: [inferAdditionalFields<Auth>(), twoFactorClient()],
});

export const { signIn, signOut, useSession } = authClient;
