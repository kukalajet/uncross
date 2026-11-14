import { Schema } from "effect";

// A pragmatic shape check: one "@", no whitespace or control characters, and a
// dot in the domain. Deliverability is the mail provider's concern, not this
// schema's.
const emailPattern = /^[^\s\p{Cc}@]+@[^\s\p{Cc}@]+\.[^\s\p{Cc}@]+$/u;

// Control characters (Unicode category Cc) have no place in a name, and
// PostgreSQL text cannot store NUL at all.
const noControlCharactersPattern = /^\P{Cc}*$/u;

// 320 = a 64-character local part, "@", and a 255-character domain (RFC 5321).
const Email = Schema.Trim.check(
  Schema.isPattern(emailPattern),
  Schema.isMaxLength(320),
);
type Email = typeof Email.Type;

const DisplayName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(noControlCharactersPattern),
);
type DisplayName = typeof DisplayName.Type;

const UserId = Schema.String.check(Schema.isUUID());
type UserId = typeof UserId.Type;

const CreateUserSchema = Schema.Struct({
  email: Email,
  displayName: DisplayName,
});
type CreateUser = typeof CreateUserSchema.Type;

const UserSchema = Schema.Struct({
  id: UserId,
  email: Email,
  displayName: DisplayName,
  createdAt: Schema.Date,
});
type User = typeof UserSchema.Type;

class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: UserId,
}) {}

class UserAlreadyExists extends Schema.TaggedError<UserAlreadyExists>()(
  "UserAlreadyExists",
  { email: Email },
) {}

export {
  type CreateUser,
  CreateUserSchema,
  DisplayName,
  Email,
  type User,
  UserAlreadyExists,
  UserId,
  UserNotFound,
  UserSchema,
};
