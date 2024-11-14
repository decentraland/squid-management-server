import { IHttpServerComponent } from "@well-known-components/interfaces";
import { Context, StatusCode } from "../types";

async function withAuthTokenValidation(
  context: IHttpServerComponent.DefaultContext<Context<string>>,
  next: () => Promise<IHttpServerComponent.IResponse>
): Promise<IHttpServerComponent.IResponse> {
  // Validate Authorization header
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      status: StatusCode.UNAUTHORIZED,
      body: {
        ok: false,
        message: "Missing or invalid Authorization header",
      },
    };
  }

  const token = authHeader.slice(7); // Extract token after 'Bearer '
  const expectedToken = process.env.AUTH_TOKEN;

  if (token !== expectedToken) {
    return {
      status: StatusCode.UNAUTHORIZED,
      body: {
        ok: false,
        message: "Invalid authorization token",
      },
    };
  }

  return next();
}

export { withAuthTokenValidation };
