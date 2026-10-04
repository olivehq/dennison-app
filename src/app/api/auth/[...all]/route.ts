import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

export const { GET, POST } = toNextJsHandler({
  handler: (request) => getAuth().handler(request),
});
