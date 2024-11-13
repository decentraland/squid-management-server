import { Router } from "@well-known-components/http-server";
import { GlobalContext } from "../types";
import { pingHandler } from "./handlers/ping-handler";
import { squidsHandler } from "./handlers/squid-handler";
import { withAuthTokenValidation } from "./auth-middleware";

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(
  globalContext: GlobalContext
): Promise<Router<GlobalContext>> {
  const { components } = globalContext;
  const router = new Router<GlobalContext>();

  router.get("/ping", pingHandler);
  router.get("/list", withAuthTokenValidation, squidsHandler);

  return router;
}
