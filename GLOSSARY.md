# Node Effect backend template

A reusable backend starter: an HTTP API and a worker over PostgreSQL. These are
the terms its code and documents use.

## Language

### Persistence

**Persistence failure**: The failure of a repository operation that the database
could not complete, such as after a lost connection, a timeout, or stored data
that no longer decodes. _Avoid_: repository error

**Database error**: The raw error the database or its driver raised. It is the
cause inside most persistence failures, and it can contain SQL, parameters, or
stored values, so it is never logged as it is.

**Safe diagnostics**: The facts about a persistence failure or a database error
that are safe to log: the kind of failure, an error code, and the fields that
failed validation. _Avoid_: error details

**Domain error**: An expected outcome of an operation that a caller can act on,
such as a user that does not exist or an email that is already taken. _Avoid_:
business exception

**Runtime role**: The database role the API and the worker connect as. It can
read and write the application's data but cannot change the schema, which only
the database's owner can. _Avoid_: app role, application user

### Worker

**Job**: A named piece of recurring work the worker does. _Avoid_: task, worker
work

**Pass**: One run of a job. _Avoid_: tick, iteration

**Job table**: The list of every job a worker runs. _Avoid_: registry

**Job runner**: The module that runs a job table, as a one-shot pass or by
polling. _Avoid_: scheduler

**One-shot pass**: One pass of every job in the table, in order, after which the
process exits. _Avoid_: worker once

**Polling**: Running each job in its own loop, one pass at a time, waiting a
fixed interval after each pass. _Avoid_: scheduling
