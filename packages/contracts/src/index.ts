import { type Static, Type } from "@sinclair/typebox";

const Email = Type.String({
  maxLength: 254,
  minLength: 3,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
});
export const RoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("planner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);
export type AppRole = Static<typeof RoleSchema>;

export const RequestCodeBody = Type.Object({ email: Email }, { additionalProperties: false });
export const VerifyCodeBody = Type.Object(
  { email: Email, code: Type.String({ pattern: "^[0-9]{6}$" }) },
  { additionalProperties: false },
);
export const GenericAuthResponse = Type.Object(
  { message: Type.Literal("If an active account exists, a code will be sent.") },
  { additionalProperties: false },
);
export const SessionResponse = Type.Object(
  {
    authenticated: Type.Boolean(),
    csrfToken: Type.Optional(Type.String()),
    user: Type.Optional(
      Type.Object(
        {
          id: Type.String({ format: "uuid" }),
          organizationId: Type.String({ format: "uuid" }),
          role: RoleSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CreateInvitationBody = Type.Object(
  { email: Email, role: RoleSchema },
  { additionalProperties: false },
);
export const ChangeRoleBody = Type.Object({ role: RoleSchema }, { additionalProperties: false });
export const IdParams = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const EmptyResponse = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false },
);
